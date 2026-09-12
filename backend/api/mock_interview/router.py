from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from core.config import get_config
from services import mock_interview_audio, mock_interview_llm
from services.storage import mock_interview

router = APIRouter()


class CreateSessionRequest(BaseModel):
    company: str = ""
    role: str = Field(min_length=1)
    language: str = "中文"
    jd_snapshot: str = ""
    resume_snapshot: str = ""
    planned_question_count: int = Field(default=5, ge=1, le=50)


class SubmitAnswerRequest(BaseModel):
    answer_text: str = Field(min_length=1)
    duration_ms: int = Field(default=0, ge=0, le=24 * 60 * 60 * 1000)


def _llm_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, mock_interview_llm.MockInterviewLLMError):
        return HTTPException(status_code=502, detail=str(exc))
    return HTTPException(status_code=502, detail="模拟面试模型调用失败，请检查模型配置。")


def _audio_answer_error(exc: Exception) -> HTTPException:
    if isinstance(exc, mock_interview_audio.AudioAnswerError):
        return HTTPException(status_code=422, detail=str(exc))
    return HTTPException(status_code=422, detail="语音作答处理失败，请稍后重试。")


async def _kb_context_for_question(session: dict) -> list[dict]:
    """针对出题查询检索知识库，返回注入 prompt 的 KB 片段。

    KB 关闭或无命中时返回空列表，调用方不传 kb_context，
    保持与未启用 KB 时逐字节一致的行为。
    """
    cfg = get_config()
    if not bool(getattr(cfg, "kb_enabled", False)):
        return []
    query = (session.get("jd_snapshot") or session.get("role") or "").strip()
    if not query:
        return []
    try:
        from services.kb.retriever import retrieve as _kb_retrieve

        hits = await run_in_threadpool(
            _kb_retrieve,
            query,
            int(getattr(cfg, "kb_top_k", 4) or 4),
            int(getattr(cfg, "kb_deadline_ms", 150) or 150),
            mode="manual_text",
        )
    except Exception:
        return []
    return [
        {"path": hit.path, "text": hit.excerpt(200)}
        for hit in hits
        if getattr(hit, "excerpt", None)
    ]


@router.post("/mock-interview/sessions")
async def create_session(req: CreateSessionRequest):
    try:
        return mock_interview.create_session(
            company=req.company,
            role=req.role,
            language=req.language,
            jd_snapshot=req.jd_snapshot,
            resume_snapshot=req.resume_snapshot,
            planned_question_count=req.planned_question_count,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"创建模拟面试会话失败：{exc}") from exc


@router.get("/mock-interview/sessions")
async def list_sessions(page: int = 1, page_size: int = 20):
    return mock_interview.list_sessions(page=page, page_size=page_size)


@router.get("/mock-interview/sessions/{session_id}")
async def get_session(session_id: int):
    detail = mock_interview.get_session_detail(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="模拟面试会话不存在")
    return detail


@router.post("/mock-interview/sessions/{session_id}/questions")
async def generate_question(session_id: int):
    detail = mock_interview.get_session_detail(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="模拟面试会话不存在")
    if detail["status"] == "completed":
        raise HTTPException(status_code=409, detail="会话已完成，不能继续出题")
    if detail["question_count"] >= detail["planned_question_count"]:
        raise HTTPException(status_code=409, detail="已达到本场计划题数")

    kb_context = await _kb_context_for_question(detail)

    try:
        if kb_context:
            draft = mock_interview_llm.generate_question(
                session=detail,
                previous_questions=detail["questions"],
                chat_json=mock_interview_llm.default_chat_json,
                kb_context=kb_context,
            )
        else:
            draft = mock_interview_llm.generate_question(
                session=detail,
                previous_questions=detail["questions"],
                chat_json=mock_interview_llm.default_chat_json,
            )
    except Exception as exc:
        raise _llm_http_error(exc) from exc

    try:
        return mock_interview.add_question(
            session_id=session_id,
            seq=detail["question_count"] + 1,
            question_text=draft["question_text"],
            question_type=draft["question_type"],
            skill_tags=draft["skill_tags"],
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="模拟面试会话不存在") from exc


@router.post("/mock-interview/questions/{question_id}/answer")
async def submit_answer(question_id: int, req: SubmitAnswerRequest):
    try:
        return mock_interview.submit_answer(
            question_id=question_id,
            answer_text=req.answer_text,
            duration_ms=req.duration_ms,
        )
    except ValueError as exc:
        message = str(exc)
        if "not found" in message:
            raise HTTPException(status_code=404, detail="模拟面试题目不存在") from exc
        raise HTTPException(status_code=409, detail=message) from exc


@router.post("/mock-interview/questions/{question_id}/answer/audio")
async def submit_audio_answer(
    question_id: int,
    file: UploadFile = File(...),
    duration_ms: int = 0,
):
    """接收 WAV 语音回答，ASR 转写后按文字回答落库。"""
    raw = await file.read()
    cfg = get_config()
    try:
        audio, sample_rate = mock_interview_audio.decode_wav_to_float32(raw)
        answer_text = await run_in_threadpool(
            mock_interview_audio.transcribe_answer,
            audio,
            sample_rate,
            getattr(cfg, "position", "") or "",
            getattr(cfg, "language", "") or "",
        )
    except mock_interview_audio.AudioAnswerError as exc:
        raise _audio_answer_error(exc) from exc
    except Exception as exc:
        raise _audio_answer_error(exc) from exc

    try:
        return mock_interview.submit_answer(
            question_id=question_id,
            answer_text=answer_text,
            duration_ms=duration_ms,
        )
    except ValueError as exc:
        message = str(exc)
        if "not found" in message:
            raise HTTPException(status_code=404, detail="模拟面试题目不存在") from exc
        raise HTTPException(status_code=409, detail=message) from exc


@router.post("/mock-interview/questions/{question_id}/feedback")
async def generate_feedback(question_id: int):
    question = mock_interview.get_question(question_id)
    if not question:
        raise HTTPException(status_code=404, detail="模拟面试题目不存在")
    if question["status"] != "answered":
        raise HTTPException(status_code=409, detail="题目未回答或已点评")

    try:
        feedback = mock_interview_llm.generate_feedback(
            question=question,
            chat_json=mock_interview_llm.default_chat_json,
        )
    except Exception as exc:
        raise _llm_http_error(exc) from exc

    try:
        return mock_interview.save_feedback(question_id=question_id, **feedback)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/mock-interview/sessions/{session_id}/report")
async def generate_session_report_endpoint(session_id: int):
    detail = mock_interview.get_session_detail(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="模拟面试会话不存在")
    if detail["status"] != "completed":
        raise HTTPException(status_code=409, detail="会话未完成，不能生成整场报告")

    try:
        report = mock_interview_llm.generate_session_report(
            session=detail,
            chat_json=mock_interview_llm.default_chat_json,
        )
    except Exception as exc:
        raise _llm_http_error(exc) from exc

    try:
        return mock_interview.save_session_report(session_id=session_id, **report)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/mock-interview/sessions/{session_id}/report/export")
async def export_session_report(session_id: int):
    """把整场报告导出为 Markdown 下载（学习沉淀）。

    报告未生成时返回 409；不存在会话返回 404。
    """
    detail = mock_interview.get_session_detail(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="模拟面试会话不存在")
    if not (detail.get("report_markdown") or "").strip():
        raise HTTPException(status_code=409, detail="整场报告尚未生成，请先生成报告")

    from urllib.parse import quote

    company = (detail.get("company") or "").strip() or "unnamed"
    role = (detail.get("role") or "").strip() or "unknown"
    md = detail["report_markdown"]
    filename = f"mock-interview-{session_id}-{company}-{role}.md".replace("/", "_").replace("\\", "_")
    # RFC 5987: header 行只允许 ASCII，中文文件名用 filename* 编码
    encoded = quote(filename)

    def _list_block(title: str, items) -> str:
        items = [str(x).strip() for x in (items or []) if str(x).strip()]
        if not items:
            return ""
        lines = "\n".join(f"- {item}" for item in items)
        return f"\n## {title}\n{lines}\n"

    body = (
        f"# 模拟面试报告：{company} · {role}\n\n"
        f"> 会话 ID：{session_id}｜生成时间：{detail.get('report_generated_at') or '—'}\n\n"
        f"{md}\n"
        f"{_list_block('优势', detail.get('report_strengths'))}"
        f"{_list_block('弱项', detail.get('report_weaknesses'))}"
        f"{_list_block('练习重点', detail.get('report_focus_areas'))}"
    )
    return Response(
        content=body.encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}"},
    )


@router.post("/mock-interview/sessions/{session_id}/practice")
async def create_practice_session(session_id: int):
    if not mock_interview.get_session_detail(session_id):
        raise HTTPException(status_code=404, detail="模拟面试会话不存在")
    try:
        return mock_interview.create_practice_session(parent_session_id=session_id)
    except ValueError as exc:
        message = str(exc)
        if "not found" in message:
            raise HTTPException(status_code=404, detail="模拟面试会话不存在") from exc
        raise HTTPException(status_code=409, detail=message) from exc

@router.post("/mock-interview/sessions/{session_id}/finish")
async def finish_session(session_id: int):
    detail = mock_interview.get_session_detail(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="模拟面试会话不存在")
    if not mock_interview.finish_session(session_id):
        raise HTTPException(status_code=409, detail="会话未完成：仍有题目未回答或未点评")
    return {"ok": True, "status": "completed"}

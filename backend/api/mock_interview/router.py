from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import mock_interview_llm
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

    try:
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

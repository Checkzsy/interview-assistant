"""模拟面试 LLM 服务：出题与回答点评的结构化输出层。

The module intentionally accepts an injectable ``chat_json`` callable. API and
runtime adapters can pass an OpenAI-compatible client later, while tests use a
pure fake and never perform network calls.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Optional

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class MockInterviewLLMError(RuntimeError):
    """Raised when the model output cannot be trusted as interview data."""


class QuestionDraft(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    question_text: str = Field(min_length=1)
    question_type: str = Field(default="general", min_length=1)
    skill_tags: list[str] = Field(default_factory=list)


class FeedbackDimension(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1)
    score: float = Field(ge=0, le=10)
    comment: str = Field(default="")


class FeedbackDraft(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    overall_score: float = Field(ge=0, le=10)
    dimensions: list[FeedbackDimension] = Field(default_factory=list)
    strengths: list[str] = Field(default_factory=list)
    improvements: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    reference_answer: str = Field(default="")


ChatJson = Callable[[str], Any]


class SessionReportDraft(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    summary_markdown: str = Field(min_length=1)
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    focus_areas: list[str] = Field(default_factory=list)


def _extract_json(raw: Any) -> Any:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        raise MockInterviewLLMError("模型返回格式无效，期望 JSON 对象。")

    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()

    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise MockInterviewLLMError("模型返回中未找到 JSON 对象。")
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        raise MockInterviewLLMError("模型返回的 JSON 无法解析。") from None
    if not isinstance(parsed, dict):
        raise MockInterviewLLMError("模型返回格式无效，期望 JSON 对象。")
    return parsed


def _validation_error(field: str) -> MockInterviewLLMError:
    return MockInterviewLLMError(f"模型返回的 {field} 无效。")


def _question_prompt(session: dict[str, Any], previous_questions: list[dict[str, Any]]) -> str:
    previous_lines: list[str] = []
    for index, item in enumerate(previous_questions):
        seq = item.get("seq", index + 1)
        question = item.get("question_text", "")
        answer = (item.get("answer_text") or "").strip()
        if answer:
            previous_lines.append(f"{seq}. \u95ee\u9898\uff1a{question}\n   \u5019\u9009\u4eba\u56de\u7b54\uff1a{answer}")
        else:
            previous_lines.append(f"{seq}. \u95ee\u9898\uff1a{question}")
    previous_text = "\n".join(previous_lines) or "\uff08\u672c\u573a\u8fd8\u6ca1\u6709\u9898\u76ee\uff09"
    return f"""你是一名严谨的{session.get('language') or '中文'}技术面试官，正在面试{session.get('company') or '未提供公司'}的{session.get('role') or '未提供岗位'}候选人。

岗位描述快照：
{session.get('jd_snapshot') or '（未提供）'}

简历快照：
{session.get('resume_snapshot') or '（未提供）'}

已提问：
{previous_text}

请生成下一道面试题。要求：
1. 题目必须贴合岗位描述和候选人真实经历。
2. 不得编造简历中不存在的经历。
3. 不要重复已提问。
4. 优先考察岗位关键能力、项目细节或技术取舍。
5. 只返回 JSON，不输出解释。

JSON 格式：
{{
  "question_text": "面试题文本",
  "question_type": "technical/behavioral/project/system_design/general",
  "skill_tags": ["技能或考察点"]
}}
"""


def _feedback_prompt(question: dict[str, Any]) -> str:
    return f"""你是一名严谨的技术面试评审。请点评候选人的模拟面试回答。

面试题：
{question.get('question_text') or ''}

候选人回答：
{question.get('answer_text') or ''}

点评要求：
1. overall_score 是 0 到 10 的数字。
2. dimensions 中每个 score 也是 0 到 10。
3. evidence 只能引用候选人回答中的原文信息，不得编造。
4. improvements 要具体可执行。
5. reference_answer 与候选人原回答分开，不要伪装成候选人说过的话。
6. 只返回 JSON，不输出解释。

JSON 格式：
{{
  "overall_score": 0,
  "dimensions": [{{"name": "事实正确性", "score": 0, "comment": "说明"}}],
  "strengths": ["优点"],
  "improvements": ["改进建议"],
  "evidence": ["回答中的原文证据"],
  "reference_answer": "参考回答"
}}
"""


def _session_report_prompt(session: dict[str, Any]) -> str:
    question_lines: list[str] = []
    for index, question in enumerate(session.get("questions", [])):
        feedback = question.get("feedback") or {}
        dimensions = feedback.get("dimensions") or []
        improvements = feedback.get("improvements") or []
        dimension_text = "；".join(
            f"{dimension.get('name')} {dimension.get('score')} 分：{dimension.get('comment')}"
            for dimension in dimensions
        ) or "（无维度点评）"
        improvement_text = "；".join(improvements) or "（无改进建议）"
        question_lines.append(
            f"第 {question.get('seq', index + 1)} 题：{question.get('question_text', '')}\n"
            f"候选人回答：{question.get('answer_text') or ''}\n"
            f"总分：{question.get('overall_score')}\n"
            f"维度点评：{dimension_text}\n"
            f"改进建议：{improvement_text}"
        )
    questions_text = "\n\n".join(question_lines) or "（本场没有已点评题目）"
    return f"""你是一名严谨的技术面试教练。请基于以下已完成模拟面试的逐题点评生成整场报告。

公司：{session.get('company') or '未提供'}
岗位：{session.get('role') or '未提供'}
岗位描述快照：
{session.get('jd_snapshot') or '未提供'}

逐题记录：
{questions_text}

报告要求：
1. summary_markdown 使用 Markdown，先给整场结论，再说明主要表现。
2. strengths 和 weaknesses 必须来自逐题点评或候选人回答，不得编造。
3. focus_areas 是后续练习重点，每项要具体可执行。
4. 不要泄露或复述无关隐私。
5. 只返回 JSON，不输出解释。

JSON 格式：
{{
  "summary_markdown": "## 整场总结\n...",
  "strengths": ["优势"],
  "weaknesses": ["弱项"],
  "focus_areas": ["后续练习重点"]
}}
"""


def generate_session_report(*, session: dict[str, Any], chat_json: ChatJson) -> dict[str, Any]:
    prompt = _session_report_prompt(session)
    try:
        draft = SessionReportDraft(**_extract_json(chat_json(prompt)))
    except ValidationError as exc:
        fields = sorted({str(error["loc"][0]) for error in exc.errors() if error.get("loc")})
        field = fields[0] if fields else "报告字段"
        raise _validation_error(field) from None
    return draft.model_dump()


def default_chat_json(prompt: str) -> Any:
    """Call the configured review model and return its raw content.

    This is the only place in the mock-interview domain that knows about the
    OpenAI-compatible SDK; routes and generation functions stay testable with a
    pure ``chat_json`` callable.
    """
    from core.config import get_config
    from services.llm.streaming import get_client_for_model

    cfg = get_config()
    model = cfg.get_review_model()
    if not model.api_key or model.api_key in ("", "sk-your-api-key-here"):
        raise MockInterviewLLMError("模拟面试模型未配置有效 API Key。")

    client = get_client_for_model(model)
    response = client.chat.completions.create(
        model=model.model,
        messages=[
            {"role": "system", "content": "你是严谨的面试官，只返回合法 JSON。"},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
        max_tokens=1600,
    )
    return response.choices[0].message.content


def generate_question(
    *,
    session: dict[str, Any],
    previous_questions: Optional[list[dict[str, Any]]] = None,
    chat_json: ChatJson,
) -> dict[str, Any]:
    prompt = _question_prompt(session, previous_questions or [])
    try:
        draft = QuestionDraft(**_extract_json(chat_json(prompt)))
    except ValidationError:
        raise _validation_error("面试题字段") from None
    return draft.model_dump()


def generate_feedback(*, question: dict[str, Any], chat_json: ChatJson) -> dict[str, Any]:
    prompt = _feedback_prompt(question)
    try:
        draft = FeedbackDraft(**_extract_json(chat_json(prompt)))
    except ValidationError as exc:
        fields = sorted({str(error["loc"][0]) for error in exc.errors() if error.get("loc")})
        field = fields[0] if fields else "点评字段"
        raise _validation_error(field) from None
    return draft.model_dump()

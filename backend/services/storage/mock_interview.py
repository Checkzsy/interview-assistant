"""模拟面试会话、题目、回答与点评的 SQLite 存储。"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Optional

from services.storage.paths import sqlite_path

DB_PATH = sqlite_path("mock_interview.db")
_db_lock = threading.Lock()

_JSON_LIST_FIELDS = ("skill_tags", "dimensions", "strengths", "improvements", "evidence")


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _bounded_int(value: Any, *, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, parsed))


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with _db_lock:
        conn = _conn()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS mock_interview_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    status TEXT NOT NULL DEFAULT 'created',
                    company TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL DEFAULT '',
                    language TEXT NOT NULL DEFAULT '中文',
                    jd_snapshot TEXT NOT NULL DEFAULT '',
                    resume_snapshot TEXT NOT NULL DEFAULT '',
                    planned_question_count INTEGER NOT NULL DEFAULT 5,
                    parent_session_id INTEGER,
                    focus_areas_json TEXT,
                    report_markdown TEXT,
                    report_strengths_json TEXT,
                    report_weaknesses_json TEXT,
                    report_focus_areas_json TEXT,
                    report_generated_at REAL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS mock_interview_questions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    seq INTEGER NOT NULL,
                    question_text TEXT NOT NULL,
                    question_type TEXT NOT NULL DEFAULT 'general',
                    skill_tags_json TEXT,
                    status TEXT NOT NULL DEFAULT 'waiting_answer',
                    answer_text TEXT,
                    duration_ms INTEGER NOT NULL DEFAULT 0,
                    overall_score REAL,
                    dimensions_json TEXT,
                    strengths_json TEXT,
                    improvements_json TEXT,
                    evidence_json TEXT,
                    reference_answer TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES mock_interview_sessions(id)
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_mock_questions_session ON mock_interview_questions(session_id, seq)"
            )
            for column, definition in (
                ("parent_session_id", "INTEGER"),
                ("focus_areas_json", "TEXT"),
                ("report_markdown", "TEXT"),
                ("report_strengths_json", "TEXT"),
                ("report_weaknesses_json", "TEXT"),
                ("report_focus_areas_json", "TEXT"),
                ("report_generated_at", "REAL"),
            ):
                _ensure_column(conn, "mock_interview_sessions", column, definition)
            conn.commit()
        finally:
            conn.close()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _question_from_row(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    for field in _JSON_LIST_FIELDS:
        raw = item.pop(f"{field}_json", None)
        try:
            parsed = json.loads(raw) if raw else []
            item[field] = parsed if isinstance(parsed, list) else []
        except (json.JSONDecodeError, TypeError):
            item[field] = []
    if item.get("status") != "reviewed":
        item["feedback"] = None
        return item

    item["feedback"] = {
        "overall_score": item.get("overall_score"),
        "dimensions": item.get("dimensions", []),
        "strengths": item.get("strengths", []),
        "improvements": item.get("improvements", []),
        "evidence": item.get("evidence", []),
        "reference_answer": item.get("reference_answer"),
    }
    return item


def _refresh_session_progress(conn: sqlite3.Connection, session_id: int) -> None:
    row = conn.execute(
        """
        SELECT
            COUNT(*) AS question_count,
            SUM(CASE WHEN status IN ('answered', 'reviewed') THEN 1 ELSE 0 END) AS answered_count,
            SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) AS reviewed_count,
            AVG(CASE WHEN status = 'reviewed' THEN overall_score END) AS average_score
        FROM mock_interview_questions
        WHERE session_id = ?
        """,
        (session_id,),
    ).fetchone()
    if not row or not row["question_count"]:
        return
    # Completion is explicit through finish_session(); feedback only advances progress.
    status = "in_progress"
    conn.execute(
        "UPDATE mock_interview_sessions SET status = ?, updated_at = ? WHERE id = ?",
        (status, time.time(), session_id),
    )


def list_sessions(page: int = 1, page_size: int = 20) -> dict[str, Any]:
    page = _bounded_int(page, fallback=1, minimum=1, maximum=1_000_000)
    page_size = _bounded_int(page_size, fallback=20, minimum=1, maximum=100)
    offset = (page - 1) * page_size
    with _db_lock:
        conn = _conn()
        try:
            total = conn.execute("SELECT COUNT(*) AS c FROM mock_interview_sessions").fetchone()["c"]
            rows = conn.execute(
                """
                SELECT
                    s.*,
                    COUNT(q.id) AS question_count,
                    SUM(CASE WHEN q.status IN ('answered', 'reviewed') THEN 1 ELSE 0 END) AS answered_question_count,
                    SUM(CASE WHEN q.status = 'reviewed' THEN 1 ELSE 0 END) AS reviewed_question_count,
                    AVG(CASE WHEN q.status = 'reviewed' THEN q.overall_score END) AS average_score
                FROM mock_interview_sessions AS s
                LEFT JOIN mock_interview_questions AS q ON q.session_id = s.id
                GROUP BY s.id
                ORDER BY s.created_at DESC
                LIMIT ? OFFSET ?
                """,
                (page_size, offset),
            ).fetchall()
        finally:
            conn.close()

    items = []
    for row in rows:
        item = dict(row)
        item["question_count"] = int(item.get("question_count") or 0)
        item["answered_question_count"] = int(item.get("answered_question_count") or 0)
        item["reviewed_question_count"] = int(item.get("reviewed_question_count") or 0)
        item["average_score"] = round(float(item["average_score"]), 2) if item.get("average_score") is not None else None
        items.append(item)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def get_question(question_id: int) -> Optional[dict[str, Any]]:
    with _db_lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT * FROM mock_interview_questions WHERE id = ?", (question_id,)
            ).fetchone()
        finally:
            conn.close()
    return _question_from_row(row) if row else None


def create_session(
    *,
    company: str = "",
    role: str,
    language: str = "中文",
    jd_snapshot: str = "",
    resume_snapshot: str = "",
    planned_question_count: int = 5,
    parent_session_id: Optional[int] = None,
    focus_areas: Optional[list[str]] = None,
) -> dict[str, Any]:
    now = time.time()
    with _db_lock:
        conn = _conn()
        try:
            cursor = conn.execute(
                """
                INSERT INTO mock_interview_sessions (
                    status, company, role, language, jd_snapshot, resume_snapshot,
                    planned_question_count, parent_session_id, focus_areas_json,
                    created_at, updated_at
                ) VALUES ('created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _clean_text(company),
                    _clean_text(role),
                    _clean_text(language) or "中文",
                    _clean_text(jd_snapshot),
                    _clean_text(resume_snapshot),
                    _bounded_int(planned_question_count, fallback=5, minimum=1, maximum=50),
                    parent_session_id,
                    json.dumps(focus_areas or [], ensure_ascii=False),
                    now,
                    now,
                ),
            )
            session_id = int(cursor.lastrowid)
            conn.commit()
            row = conn.execute(
                "SELECT * FROM mock_interview_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            session = dict(row)
            session["question_count"] = 0
            session["answered_question_count"] = 0
            session["reviewed_question_count"] = 0
            session["average_score"] = None
            session["focus_areas"] = focus_areas or []
            return session
        finally:
            conn.close()


def create_practice_session(*, parent_session_id: int) -> dict[str, Any]:
    parent = get_session_detail(parent_session_id)
    if not parent:
        raise ValueError("Mock interview parent session not found")
    if parent.get("status") != "completed" or not parent.get("report_focus_areas"):
        raise ValueError("父会话必须已完成且已生成报告")

    focus_areas = list(dict.fromkeys(
        item.strip() for item in parent["report_focus_areas"] if str(item).strip()
    ))[:50]
    if not focus_areas:
        raise ValueError("父会话报告没有可用的练习重点")

    return create_session(
        company=parent.get("company") or "",
        role=parent.get("role") or "",
        language=parent.get("language") or "中文",
        jd_snapshot=parent.get("jd_snapshot") or "",
        resume_snapshot=parent.get("resume_snapshot") or "",
        planned_question_count=len(focus_areas),
        parent_session_id=parent_session_id,
        focus_areas=focus_areas,
    )


def add_question(
    *,
    session_id: int,
    seq: int,
    question_text: str,
    question_type: str = "general",
    skill_tags: Optional[list[str]] = None,
) -> dict[str, Any]:
    now = time.time()
    with _db_lock:
        conn = _conn()
        try:
            session = conn.execute(
                "SELECT id FROM mock_interview_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if not session:
                raise ValueError("Mock interview session not found")
            cursor = conn.execute(
                """
                INSERT INTO mock_interview_questions (
                    session_id, seq, question_text, question_type, status,
                    skill_tags_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'waiting_answer', ?, ?, ?)
                """,
                (
                    session_id,
                    _bounded_int(seq, fallback=1, minimum=1, maximum=10_000),
                    _clean_text(question_text),
                    _clean_text(question_type) or "general",
                    json.dumps(skill_tags or [], ensure_ascii=False),
                    now,
                    now,
                ),
            )
            question_id = int(cursor.lastrowid)
            conn.execute(
                "UPDATE mock_interview_sessions SET status = 'in_progress', updated_at = ? WHERE id = ?",
                (now, session_id),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM mock_interview_questions WHERE id = ?", (question_id,)
            ).fetchone()
            return _question_from_row(row)
        finally:
            conn.close()


def submit_answer(*, question_id: int, answer_text: str, duration_ms: int = 0) -> dict[str, Any]:
    now = time.time()
    with _db_lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT id, session_id, status FROM mock_interview_questions WHERE id = ?",
                (question_id,),
            ).fetchone()
            if not row:
                raise ValueError("Mock interview question not found")
            if row["status"] != "waiting_answer":
                raise ValueError("Question already has an answer")
            conn.execute(
                """
                UPDATE mock_interview_questions
                SET status = 'answered',
                    answer_text = ?,
                    duration_ms = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    _clean_text(answer_text),
                    _bounded_int(duration_ms, fallback=0, minimum=0, maximum=24 * 60 * 60 * 1000),
                    now,
                    question_id,
                ),
            )
            conn.execute(
                "UPDATE mock_interview_sessions SET status = 'in_progress', updated_at = ? WHERE id = ?",
                (now, row["session_id"]),
            )
            conn.commit()
            updated = conn.execute(
                "SELECT * FROM mock_interview_questions WHERE id = ?", (question_id,)
            ).fetchone()
            return _question_from_row(updated)
        finally:
            conn.close()


def save_feedback(
    *,
    question_id: int,
    overall_score: int | float,
    dimensions: list[dict[str, Any]],
    strengths: list[str],
    improvements: list[str],
    evidence: list[str],
    reference_answer: str,
) -> dict[str, Any]:
    now = time.time()
    with _db_lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT id, session_id, status FROM mock_interview_questions WHERE id = ?",
                (question_id,),
            ).fetchone()
            if not row:
                raise ValueError("Mock interview question not found")
            if row["status"] != "answered":
                raise ValueError("Question must be answered before feedback")
            conn.execute(
                """
                UPDATE mock_interview_questions
                SET status = 'reviewed',
                    overall_score = ?,
                    dimensions_json = ?,
                    strengths_json = ?,
                    improvements_json = ?,
                    evidence_json = ?,
                    reference_answer = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    max(0, min(10, float(overall_score))),
                    json.dumps(dimensions or [], ensure_ascii=False),
                    json.dumps(strengths or [], ensure_ascii=False),
                    json.dumps(improvements or [], ensure_ascii=False),
                    json.dumps(evidence or [], ensure_ascii=False),
                    _clean_text(reference_answer),
                    now,
                    question_id,
                ),
            )
            _refresh_session_progress(conn, int(row["session_id"]))
            conn.commit()
            updated = conn.execute(
                "SELECT * FROM mock_interview_questions WHERE id = ?", (question_id,)
            ).fetchone()
            return _question_from_row(updated)
        finally:
            conn.close()


def get_session_detail(session_id: int) -> Optional[dict[str, Any]]:
    with _db_lock:
        conn = _conn()
        try:
            session_row = conn.execute(
                "SELECT * FROM mock_interview_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if not session_row:
                return None
            question_rows = conn.execute(
                "SELECT * FROM mock_interview_questions WHERE session_id = ? ORDER BY seq ASC",
                (session_id,),
            ).fetchall()
        finally:
            conn.close()

    session = dict(session_row)
    questions = [_question_from_row(row) for row in question_rows]
    session["questions"] = questions
    focus_raw = session.pop("focus_areas_json", None)
    try:
        parsed_focus = json.loads(focus_raw) if focus_raw else []
        session["focus_areas"] = parsed_focus if isinstance(parsed_focus, list) else []
    except (json.JSONDecodeError, TypeError):
        session["focus_areas"] = []
    for field in ("report_strengths", "report_weaknesses", "report_focus_areas"):
        raw = session.pop(f"{field}_json", None)
        try:
            parsed = json.loads(raw) if raw else []
            session[field] = parsed if isinstance(parsed, list) else []
        except (json.JSONDecodeError, TypeError):
            session[field] = []
    session["question_count"] = len(questions)
    session["answered_question_count"] = sum(q["status"] in ("answered", "reviewed") for q in questions)
    session["reviewed_question_count"] = sum(q["status"] == "reviewed" for q in questions)
    scores = [q["overall_score"] for q in questions if q["status"] == "reviewed" and q["overall_score"] is not None]
    session["average_score"] = round(sum(scores) / len(scores), 2) if scores else None
    return session


def save_session_report(
    *,
    session_id: int,
    summary_markdown: str,
    strengths: list[str],
    weaknesses: list[str],
    focus_areas: list[str],
) -> dict[str, Any]:
    with _db_lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT id, status FROM mock_interview_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if not row:
                raise ValueError("Mock interview session not found")
            if row["status"] != "completed":
                raise ValueError("Session must be completed before report generation")
            conn.execute(
                """
                UPDATE mock_interview_sessions
                SET report_markdown = ?,
                    report_strengths_json = ?,
                    report_weaknesses_json = ?,
                    report_focus_areas_json = ?,
                    report_generated_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    _clean_text(summary_markdown),
                    json.dumps(strengths or [], ensure_ascii=False),
                    json.dumps(weaknesses or [], ensure_ascii=False),
                    json.dumps(focus_areas or [], ensure_ascii=False),
                    time.time(),
                    time.time(),
                    session_id,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    return get_session_detail(session_id)


def finish_session(session_id: int) -> bool:
    with _db_lock:
        conn = _conn()
        try:
            session = conn.execute(
                "SELECT id FROM mock_interview_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if not session:
                raise ValueError("Mock interview session not found")
            stats = conn.execute(
                """
                SELECT
                    COUNT(q.id) AS question_count,
                    SUM(CASE WHEN q.status = 'reviewed' THEN 1 ELSE 0 END) AS reviewed_count,
                    s.planned_question_count
                FROM mock_interview_sessions AS s
                LEFT JOIN mock_interview_questions AS q ON q.session_id = s.id
                WHERE s.id = ?
                GROUP BY s.id
                """,
                (session_id,),
            ).fetchone()
            if (
                not stats
                or stats["question_count"] != stats["planned_question_count"]
                or stats["reviewed_count"] != stats["question_count"]
            ):
                return False
            conn.execute(
                "UPDATE mock_interview_sessions SET status = 'completed', updated_at = ? WHERE id = ?",
                (time.time(), session_id),
            )
            conn.commit()
            return True
        finally:
            conn.close()

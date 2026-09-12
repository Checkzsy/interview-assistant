# 对标面小助增强拆解计划（2026-09-12）

## 目标
在本地开源 interview-assistant 上增量增强，对标面小助（mianxiaozhu）收费产品，优先补齐：
1. 实时翻译 worker（后端 + 前端展示）
2. mock-interview 出题注入知识库（KB）检索片段
3. 端到端验证器（翻译 + LLM evaluator 接入真实 DeepSeek/OpenAI 兼容模型）

## 并行任务（subagent）
| # | 任务 | 写范围 | 验收 |
|---|------|--------|------|
| 1 | 后端实时翻译 worker | backend/api/assist/translate_worker.py、asr_state.py、main.py、__init__.py、tests/test_translate_worker.py | pytest + ruff |
| 2 | mock-interview 出题注入 KB | backend/services/mock_interview_llm.py、tests/test_mock_interview_kb.py | pytest + ruff |
| 3 | 前端实时翻译展示 | frontend/src/hooks/useInterviewWS.ts、stores/slices/interviewSlice.ts、components/TranscriptionPanel.tsx + 测试 | npm test + tsc |
| 4 | 端到端验证器 | backend/scripts/verify_translate_and_eval.py、tests/test_verify_translate_and_eval.py、run_mock_interview_eval.py | pytest + ruff |

## 关键契约
- WS 消息：`transcription_translated` {seq, text}、`transcription_translate_error` {seq}
- 翻译 worker：单线程有界队列（maxsize 32），失败只广播错误不阻塞 ASR
- KB 注入：`_question_prompt(session, previous_questions, kb_context=None)`，kb_context 为空时输出与原来完全一致
- 验证器：默认不调用真实模型，`--run` 才调用；未配 key 退出码 2

## 后续整合
- 等 4 个 subagent 完成后，主进程统一跑 backend pytest + frontend npm test + tsc
- 修复冲突（尤其 run_mock_interview_eval.py 可能被 #4 和已有 commit 同时改）
- 提交一个整合 commit

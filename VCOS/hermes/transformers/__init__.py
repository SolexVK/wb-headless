"""VCOS — Transformer Pipeline.

CP-001 §4.1 — Transformer Protocol.
Каждый transformer получает Semantic Graph и возвращает улучшенный Semantic Graph.

Доступные трансформеры:
  - PipelineTransformer    — оркестрация цепочки
  - DialogueTransformer    — диалог и интервью
  - InterviewTransformer   — CP-001 §8 Interview Protocol
  - LLMTransformer         — CP-001 §9 Reasoning Protocol
  - KnowledgeTransformer   — CP-001 §5 Knowledge Provider
  - DesignTransformer      — CP-001 §4.5 Design phase
  - CompileTransformer     — CP-001 §6 Renderer Protocol
  - CategoryTransformer    — фаза 0: определение категории товара
  - ProfileTransformer     — фаза -1: выбор профиля режиссёра
  - ClarifyTransformer     — фаза 5: уточнение и выбор модели
  - ExportTransformer      — фаза 6: экспорт промпта
"""

from hermes.transformers.base import Transformer, TransformerContext, TransformResult
from hermes.transformers.pipeline_transformer import PipelineTransformer
from hermes.transformers.dialogue_transformer import DialogueTransformer
from hermes.transformers.llm_transformer import LLMTransformer
from hermes.transformers.knowledge_transformer import KnowledgeTransformer
from hermes.transformers.interview_transformer import InterviewTransformer
from hermes.transformers.design_transformer import DesignTransformer
from hermes.transformers.compile_transformer import CompileTransformer
from hermes.transformers.category_transformer import CategoryTransformer
from hermes.transformers.profile_transformer import ProfileTransformer
from hermes.transformers.clarify_transformer import ClarifyTransformer
from hermes.transformers.export_transformer import ExportTransformer
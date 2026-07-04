"""VCOS — Animation Domain Pack v1

Domain knowledge for animation, motion design, 3D visualization:
- motion graphics, character animation, 3D product viz
- keyframes, timing, easing
- 3D modeling and rendering pipelines

Insight #7: Domain knowledge outside the kernel.
"""

from typing import List, Optional

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint
)


class AnimationPack(DomainPack):
    """Knowledge for animation, motion design, and 3D visualization."""

    name = "animation"
    domains = ["animation", "motion", "3d", "vfx", "character-animation",
               "motion-graphics", "анимация", "моушн", "3d-визуализация"]

    def get_questions(self, context: Optional[dict] = None) -> List[DomainQuestion]:
        ctx = context or {}
        project_type = ctx.get("project_type", "")

        questions = [
            DomainQuestion(
                block="intent", field="animation_type",
                text="🎬 **What kind of animation?**\n\n2D, 3D, motion graphics, character, or stop-motion?",
                examples=["3D product turntable, 360 rotation",
                          "2D character walk cycle, hand-drawn style"],
            ),
            DomainQuestion(
                block="environment", field="scene",
                text="🌐 **Scene and background**\n\nWhat environment? Studio, abstract, or full 3D world?",
                examples=["Neutral gray studio rotation", "Fantasy 3D world, epic lighting"],
            ),
            DomainQuestion(
                block="composition", field="timing",
                text="⏱️ **Timing and duration**\n\nHow long? Fast cut or slow motion?",
                examples=["15s loop, seamless", "3s micro, high energy"],
                required=False,
            ),
        ]

        if "3d" in project_type.lower() or "product" in project_type.lower():
            questions.append(
                DomainQuestion(
                    block="camera", field="camera_move",
                    text="📷 **Camera movement**\n\nTurntable, orbit, or dramatic dolly?",
                    examples=["360 turntable, slow rotation", "Dynamic dolly zoom"],
                )
            )

        return questions

    def get_constraints(self, context: Optional[dict] = None) -> List[DomainConstraint]:
        constraints = [
            DomainConstraint(
                description="Animation loop must be seamless (no visible start/end)",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Motion must respect easing principles (no linear unless intentional)",
                constraint_type="must_have",
            ),
        ]
        return constraints

    def get_render_hints(self, model: str) -> dict:
        hints = {
            "chatgpt": {"aspect_ratio": "16:9", "style": "animation-keyframes"},
            "midjourney": {"ar": "16:9", "style": "--ar 16:9 --s 250 --v 6"},
            "sdxl": {"width": 1344, "height": 768, "refiner": "animation"},
        }
        return hints.get(model, {})
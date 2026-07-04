"""VCOS — Typography / Editorial Domain Pack v1

Domain knowledge for typography, editorial design, print, publishing:
- book covers, magazines, posters
- editorial photography and layout
- text hierarchy and composition

Insight #7: Domain knowledge outside the kernel.
"""

from typing import List, Optional

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint
)


class TypographyEditorialPack(DomainPack):
    """Knowledge for typography, editorial, and publishing photography."""

    name = "typography-editorial"
    domains = ["typography", "editorial", "publishing", "print", "book",
               "magazine", "poster", "типография", "издательство"]

    def get_questions(self, context: Optional[dict] = None) -> List[DomainQuestion]:
        ctx = context or {}
        product_type = ctx.get("product_type", "")

        questions = [
            DomainQuestion(
                block="intent", field="media_type",
                text="📖 **What are we designing?**\n\nType of media: book cover, magazine spread, poster, packaging text?",
                examples=["Book cover hardback, textured paper", "Magazine spread, editorial layout"],
            ),
            DomainQuestion(
                block="environment", field="style",
                text="🎯 **Style direction**\n\nMinimalist, classic, avant-garde? Print or digital-first?",
                examples=["Swiss style, clean typography, grid layout",
                          "Vintage, serif fonts, warm paper texture"],
            ),
            DomainQuestion(
                block="composition", field="hierarchy",
                text="📐 **Text hierarchy**\n\nHeadline, subtitle, body — how much text?",
                examples=["Single word headline, minimal body", "Rich editorial, 3-level hierarchy"],
                required=False,
            ),
        ]

        if "cover" in product_type.lower() or "обложк" in product_type.lower():
            questions.append(
                DomainQuestion(
                    block="color", field="cover_palette",
                    text="🎨 **Cover palette**\n\nTitle contrast with background? Spot color or full CMYK?",
                    examples=["Bold red title on cream stock", "Minimal black on white, spot gloss"],
                )
            )

        return questions

    def get_constraints(self, context: Optional[dict] = None) -> List[DomainConstraint]:
        constraints = [
            DomainConstraint(
                description="Text must be legible at thumbnail size",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Typography respects baseline grid and hierarchy",
                constraint_type="must_have",
            ),
        ]
        return constraints

    def get_render_hints(self, model: str) -> dict:
        hints = {
            "chatgpt": {"aspect_ratio": "2:3", "style": "editorial-typography, clean"},
            "midjourney": {"ar": "2:3", "style": "--ar 2:3 --style raw --s 100"},
            "sdxl": {"width": 896, "height": 1344, "refiner": "editorial"},
        }
        return hints.get(model, {})
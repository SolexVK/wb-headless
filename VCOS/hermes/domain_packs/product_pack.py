"""VCOS — Product Domain Pack v1

Domain knowledge for product photography and videography:
- product shots, packaging, catalog
- marketplace standards (WB, Ozon)

Insight #7: Domain knowledge outside the kernel.
Insight #8: Domain Packs = isolated modules, not monolith.
"""

from typing import List, Optional

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint
)


class ProductPack(DomainPack):
    """Knowledge for product photography, packaging, and catalog."""

    name = "product"
    domains = ["product", "товары", "product-photography", "catalog", "packaging"]
    requires_knowledge = ["photography", "lighting"]

    def get_questions(self, context: Optional[dict] = None) -> List[DomainQuestion]:
        ctx = context or {}
        product_type = ctx.get("product_type", "")

        questions = [
            DomainQuestion(
                block="intent", field="product_type",
                text="🧴 **What are we shooting?**\n\nDescribe the product: type, brand, volume, packaging material.",
                examples=["Lipstick matte, red case, glass", "Perfume bottle 50ml, glass with engraving"],
            ),
            DomainQuestion(
                block="character", field="environment",
                text="🎯 **Shooting style**\n\nBeauty portrait, flat lay, or just packaging?",
                examples=["Flat lay on marble table", "Beauty portrait with makeup"],
            ),
            DomainQuestion(
                block="color", field="color_palette",
                text="🎨 **Color palette**\n\nBackground matching the product? Main color?",
                examples=["White minimalism for skincare", "Black gloss for perfume"],
                required=False,
            ),
        ]

        if "macro" in product_type.lower() or "texture" in product_type.lower():
            questions.append(
                DomainQuestion(
                    block="camera", field="macro",
                    text="🔍 **Macro details**\n\nClose-up of texture? Droplets, fibers, shimmer?",
                    examples=["Lipstick texture, dew drops", "Eyeshadow glitter, macro 2:1"],
                )
            )

        return questions

    def get_constraints(self, context: Optional[dict] = None) -> List[DomainConstraint]:
        ctx = context or {}
        platform = ctx.get("platform", "wb")

        constraints = [
            DomainConstraint(
                description="Color reproduction must match the product exactly",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Packaging readable: label, logo, volume visible",
                constraint_type="must_have",
            ),
        ]

        if platform == "wb":
            constraints.append(
                DomainConstraint(
                    description="White or gradient background, no reflections on packaging",
                    constraint_type="must_have",
                )
            )

        return constraints

    def get_render_hints(self, model: str) -> dict:
        hints = {
            "chatgpt": {"aspect_ratio": "1:1", "style": "beauty-photography, product-shot"},
            "midjourney": {"ar": "1:1", "style": "--ar 1:1 --style raw --s 150"},
            "sdxl": {"width": 1024, "height": 1024, "refiner": "product"},
        }
        return hints.get(model, {})
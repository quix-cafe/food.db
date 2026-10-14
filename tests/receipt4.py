
#!/usr/bin/env python3
"""Receipt parsing: PaddleOCR layout reconstruction + text-only Ollama."""

import argparse
import json
import sys
from pathlib import Path
from decimal import Decimal

from paddleocr import PaddleOCR
from ollama import chat
from pydantic import BaseModel, Field


# ---------- Structured output schema ----------

class ReceiptItem(BaseModel):
    description: str
    quantity: float | None = None
    unit_price: float | None = None
    total: float | None = None


class Receipt(BaseModel):
    merchant: str | None = None
    address: str | None = None
    date: str | None = None
    currency: str | None = None
    items: list[ReceiptItem] = Field(default_factory=list)
    subtotal: float | None = None
    tax: float | None = None
    tip: float | None = None
    discount: float | None = None
    total: float | None = None
    payment_method: str | None = None
    notes: list[str] = Field(default_factory=list)


# ---------- OCR layout reconstruction ----------

def reconstruct_rows(lines):
    """Group OCR boxes into horizontal rows, then sort by x position."""

    valid = []

    for line in lines:
        box = line.get("box")
        if not box or len(box) < 4:
            continue

        x1, y1, x2, y2 = map(float, box[:4])

        valid.append({
            **line,
            "x1": min(x1, x2),
            "x2": max(x1, x2),
            "y1": min(y1, y2),
            "y2": max(y1, y2),
            "cy": (y1 + y2) / 2,
            "height": max(1.0, abs(y2 - y1)),
        })

    # Sort vertically first.
    valid.sort(key=lambda item: (item["cy"], item["x1"]))

    rows = []

    for item in valid:
        best_row = None
        best_distance = float("inf")

        for row in rows:
            row_cy = sum(x["cy"] for x in row) / len(row)
            row_height = sorted(x["height"] for x in row)[len(row) // 2]

            # Allow different font sizes on the same printed line.
            tolerance = max(
                8.0,
                0.55 * max(item["height"], row_height),
            )

            distance = abs(item["cy"] - row_cy)

            if distance <= tolerance and distance < best_distance:
                best_row = row
                best_distance = distance

        if best_row is None:
            rows.append([item])
        else:
            best_row.append(item)

    # Sort rows vertically and fragments horizontally.
    rows.sort(key=lambda row: sum(x["cy"] for x in row) / len(row))

    for row in rows:
        row.sort(key=lambda item: item["x1"])

    return rows


def format_layout(rows):
    """Produce readable text that retains coordinates and columns."""

    output = []

    for index, row in enumerate(rows, start=1):
        center_y = sum(x["cy"] for x in row) / len(row)
        fragments = []

        for item in row:
            confidence = item.get("confidence")
            confidence_text = (
                f"{confidence:.2f}"
                if confidence is not None
                else "unknown"
            )

            fragments.append(
                f"x={item['x1']:.0f}-{item['x2']:.0f} "
                f"(conf={confidence_text}) "
                f"{item['text']}"
            )

        output.append(
            f"ROW {index:03d} y={center_y:.0f}: "
            + " | ".join(fragments)
        )

    return "\n".join(output)


# ---------- Main pipeline ----------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path, help="Receipt JPEG")
    parser.add_argument("--model", default="qwen3.5:9b")
    parser.add_argument("--out", type=Path, default=Path("receipt.json"))
    args = parser.parse_args()

    if not args.image.is_file():
        sys.exit(f"Image not found: {args.image}")

    # 1. OCR
    print("Running PaddleOCR...", file=sys.stderr)

    ocr = PaddleOCR(
        lang="en",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        enable_mkldnn=False,
    )

    results = ocr.predict(str(args.image))
    lines = []

    for result in results:
        texts = result.get("rec_texts", [])
        scores = result.get("rec_scores", [])
        boxes = result.get("rec_boxes", [])

        for i, text in enumerate(texts):
            if not text or not text.strip():
                continue

            score = float(scores[i]) if i < len(scores) else None
            box = boxes[i].tolist() if i < len(boxes) else None

            lines.append({
                "text": text.strip(),
                "confidence": score,
                "box": box,
            })

    if not lines:
        sys.exit("OCR found no readable text.")

    # 2. Preserve the original OCR evidence.
    ocr_path = args.out.with_name(args.out.stem + "_ocr.json")
    ocr_path.write_text(
        json.dumps(lines, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # 3. Reconstruct spatial reading order.
    rows = reconstruct_rows(lines)
    layout_text = format_layout(rows)

    layout_path = args.out.with_name(args.out.stem + "_layout.txt")
    layout_path.write_text(layout_text, encoding="utf-8")

    print(f"OCR fragments: {len(lines)}", file=sys.stderr)
    print(f"Reconstructed rows: {len(rows)}", file=sys.stderr)
    print(f"OCR evidence: {ocr_path}", file=sys.stderr)
    print(f"Layout evidence: {layout_path}", file=sys.stderr)

    # 4. Send TEXT ONLY to Ollama.
    prompt = f"""
Extract structured receipt data from the OCR transcript below.

The transcript preserves approximate vertical positions (y), horizontal
positions (x), OCR confidence, and left-to-right ordering within each row.

Interpret rows spatially:
- Text fragments in the same row may be separate columns.
- Item descriptions are often left-aligned; prices are often right-aligned.
- Do not combine neighboring columns into a single description.
- Rows near the bottom commonly contain subtotal, tax, and final total.
- Low OCR confidence means the text may be incorrect.
- Coordinates are approximate and are not image pixel values you should
  interpret as prices or quantities.

Rules:
- Use null when a field cannot be established from the transcript.
- Do not invent missing values.
- Preserve item descriptions as printed where possible.
- Distinguish unit prices from extended line totals.
- Represent discounts separately from purchases.
- Use ISO YYYY-MM-DD only when the date is unambiguous.
- Use ISO currency codes such as USD when supported.
- Return numeric monetary amounts as numbers.
- Add notes for ambiguous readings or incomplete information.
- Do not calculate a printed total and report it as though it were printed.
- Do not count the same item or adjustment twice.

OCR TRANSCRIPT:
{layout_text}
"""

    print(f"Parsing with text model {args.model}...", file=sys.stderr)


    response = chat(
        model=args.model,
        messages=[{"role": "user", "content": prompt}],
        format=Receipt.model_json_schema(),
        think=False,
        options={"temperature": 0},
    )


    receipt = Receipt.model_validate_json(response.message.content)

    # 5. Arithmetic diagnostics (not proof of correctness).
    warnings = []

    def money(value):
        return Decimal(str(value)).quantize(Decimal("0.01"))

    item_totals = [
        money(item.total)
        for item in receipt.items
        if item.total is not None
    ]

    if receipt.subtotal is not None and item_totals:
        item_sum = sum(item_totals, Decimal("0.00"))

        if item_sum != money(receipt.subtotal):
            warnings.append(
                f"Item totals sum to {item_sum}; "
                f"printed subtotal is {money(receipt.subtotal)}."
            )

    if receipt.total is not None and receipt.subtotal is not None:
        expected = money(receipt.subtotal)

        for value in (receipt.tax, receipt.tip):
            if value is not None:
                expected += money(value)

        if receipt.discount is not None:
            expected -= money(receipt.discount)

        if expected != money(receipt.total):
            warnings.append(
                f"Basic subtotal/tax/discount check gives {expected}; "
                f"printed total is {money(receipt.total)}. "
                "Other fees or adjustments may apply."
            )

    output = receipt.model_dump()
    output["validation"] = {
        "needs_review": bool(warnings or receipt.notes),
        "warnings": warnings,
    }

    args.out.write_text(
        json.dumps(output, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"\nSaved: {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()

import os

# Disable buggy Paddle features globally before imports
os.environ["FLAGS_use_mkldnn"] = "0"
os.environ["FLAGS_enable_pir_api"] = "0"
os.environ["FLAGS_enable_pir_in_executor"] = "0"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

import json
import re

import gradio as gr
import ollama
from paddleocr import PaddleOCR

# Initialize PaddleOCR (3.x API)
ocr_engine = PaddleOCR(
    use_textline_orientation=True,
    lang="en",
    enable_mkldnn=False,  # the oneDNN path is what triggers the PIR attribute error
    use_doc_orientation_classify=False,  # skip unneeded doc preprocessing (faster, fewer failure points)
    use_doc_unwarping=False,
)

# Define the Ollama model to use
OLLAMA_MODEL = "qwen3.5:9b"


def extract_json_from_llm(response_text):
    """Cleans up markdown artifacts / stray prose to ensure valid JSON."""
    candidates = []

    # Content inside a markdown code fence, if present
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", response_text, re.DOTALL)
    if match:
        candidates.append(match.group(1))

    # Outermost {...} block, in case the model added prose around it
    start, end = response_text.find("{"), response_text.rfind("}")
    if start != -1 and end > start:
        candidates.append(response_text[start : end + 1])

    candidates.append(response_text.strip())

    for cand in candidates:
        try:
            return json.loads(cand)
        except json.JSONDecodeError:
            continue
    return {"error": "Failed to parse JSON", "raw_output": response_text}


def extract_ocr_lines(result):
    """Pull text lines out of PaddleOCR output (3.x dict format, with 2.x fallback)."""
    lines = []
    for page in result or []:
        if page is None:
            continue
        # PaddleOCR 3.x: result objects behave like dicts with 'rec_texts'
        try:
            texts = page["rec_texts"]
        except (KeyError, TypeError, IndexError):
            texts = None
        if texts is not None:
            lines.extend(t for t in texts if t and str(t).strip())
            continue
        # PaddleOCR 2.x: list of [box, (text, score)]
        if isinstance(page, list):
            for line in page:
                try:
                    lines.append(line[1][0])
                except (IndexError, TypeError):
                    continue
    return lines


def process_receipt(image_path):
    if not image_path:
        return {"error": "No image provided"}, ""

    # 1. Run PaddleOCR
    try:
        result = ocr_engine.predict(image_path)
    except Exception as e:
        return {"error": f"OCR failed: {e}"}, ""

    extracted_lines = extract_ocr_lines(result)
    if not extracted_lines:
        return {"error": "No text detected in image"}, ""

    raw_ocr_text = "\n".join(extracted_lines)

    # 2. Structure data with Ollama
    prompt = f"""
You are a highly accurate data extraction assistant.
Analyze the following raw OCR text from a receipt and extract the information into a strict JSON format.
Do not include any explanations, greetings, or markdown formatting outside the JSON object.
Use numbers (not strings) for TotalAmount, TaxAmount and Price. Use null for anything not found.

Required JSON structure:
{{
  "MerchantName": "string",
  "Date": "string (YYYY-MM-DD if possible)",
  "TotalAmount": 0.0,
  "TaxAmount": 0.0,
  "Items": [
    {{
      "Description": "string",
      "Price": 0.0
    }}
  ]
}}

Raw OCR Text:
{raw_ocr_text}
"""

    try:
        response = ollama.chat(
            model=OLLAMA_MODEL,
            messages=[{"role": "user", "content": prompt}],
            think=False,  # disable thinking mode (needs ollama python >= 0.5)
            format="json",  # constrain output to valid JSON
            options={"temperature": 0},
        )
        parsed_json = extract_json_from_llm(response["message"]["content"])
    except Exception as e:
        parsed_json = {"error": str(e)}

    return parsed_json, raw_ocr_text


# 3. Build the Gradio UI
with gr.Blocks(title="Receipt Parser & Verifier") as app:
    gr.Markdown("# 🧾 Receipt OCR & JSON Parser")
    gr.Markdown(
        "Upload a receipt. The system uses PaddleOCR to read the text and "
        "Ollama to map it into structured JSON."
    )

    with gr.Row():
        # Left Column: Input & Visual Verification
        with gr.Column(scale=1):
            image_input = gr.Image(
                type="filepath", label="1. Upload Receipt Image (Visual Reference)"
            )
            process_btn = gr.Button("Extract Data", variant="primary")

        # Right Column: Outputs
        with gr.Column(scale=1):
            json_output = gr.JSON(label="2. Extracted JSON Data")
            with gr.Accordion("View Raw OCR Text (Debugging)", open=False):
                raw_text_output = gr.Textbox(label="PaddleOCR Output", lines=10)

    process_btn.click(
        fn=process_receipt,
        inputs=[image_input],
        outputs=[json_output, raw_text_output],
    )

if __name__ == "__main__":
    app.launch(server_name="0.0.0.0", server_port=7860)

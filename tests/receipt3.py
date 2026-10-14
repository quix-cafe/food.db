import ollama
import json
import argparse
import sys
import os
from PIL import Image

def process_receipt_vision(image_path, verbose=False):
    if not os.path.exists(image_path):
        print(f"Error: File not found at {image_path}")
        sys.exit(1)

    # --- NEW: Image Resizing to prevent Context/VRAM Overflow ---
    temp_path = "temp_resized_receipt.jpg"
    try:
        if verbose: print("Resizing and normalizing image...")
        with Image.open(image_path) as img:
            # Downscale to max 1024x1024 while maintaining aspect ratio
            img.thumbnail((1024, 1024))
            # Force standard RGB JPEG (strips weird alpha channels/color profiles)
            img.convert("RGB").save(temp_path, "JPEG")
    except Exception as e:
        print(f"Image Processing Error: {e}")
        sys.exit(1)

    prompt = """
    Analyze this receipt image and extract the data into a JSON object.
    Required keys:
    - "store_name" (string)
    - "date" (string)
    - "items" (list of objects with "name" and "price")
    - "total_amount" (number)

    Return ONLY the raw JSON object. Do not include markdown formatting, backticks, or any conversational text.
    """

    if verbose:
        print(f"Sending normalized image to qwen3-vl:8b...")

    try:
        response = ollama.chat(
            model='qwen3-vl:8b',
            messages=[{
                'role': 'user',
                'content': prompt,
                'images': [temp_path]
            }],
            options={
                'temperature': 0.0,
                'num_ctx': 8192  # --- NEW: Expanded context window for image tokens ---
            }
        )

        raw_output = response['message']['content']

        if verbose:
            print("\n--- RAW OLLAMA RESPONSE ---")
            print(raw_output)
            print("---------------------------\n")

        cleaned_output = raw_output.replace('```json', '').replace('```', '').strip()

        # Clean up temp file
        if os.path.exists(temp_path):
            os.remove(temp_path)

        return cleaned_output

    except Exception as e:
        print(f"Vision LLM Error: {e}")
        if os.path.exists(temp_path): os.remove(temp_path)
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Local Vision LLM Receipt Parser")
    parser.add_argument("image_path", help="Path to the receipt image file")
    parser.add_argument("-v", "--verbose", action="store_true", help="Print raw model output")
    args = parser.parse_args()

    json_output = process_receipt_vision(args.image_path, args.verbose)

    try:
        if not json_output:
            raise ValueError("Model returned an empty string.")

        parsed_json = json.loads(json_output)
        print(json.dumps(parsed_json, indent=4))

    except (json.JSONDecodeError, ValueError) as e:
        print("Critical Error: Failed to parse valid JSON from model output.")
        print(f"Cleaned Output: {repr(json_output)}")

import easyocr
import ollama
import json
import argparse
import sys
import os

def process_receipt(image_path, verbose=False):
    if not os.path.exists(image_path):
        print(f"Error: File not found at {image_path}")
        sys.exit(1)

    try:
        if verbose:
            print(f"\n--- [1] STARTING OCR ON: {image_path} ---")

        reader = easyocr.Reader(['en'])
        result = reader.readtext(image_path, detail=0)
        raw_text = "\n".join(result)

        if not raw_text.strip():
            print("Error: No readable text found in the image.")
            sys.exit(1)

        if verbose:
            print("\n--- [2] RAW OCR TEXT EXTRACTED ---")
            print(raw_text)
            print("----------------------------------")

    except Exception as e:
        print(f"OCR Error: {e}")
        sys.exit(1)

    prompt = f"""
    Extract data from this receipt into a JSON object.
    Required keys: "store_name" (string), "date" (string), "items" (list of objects with "name" and "price"), "total_amount" (number).

    Receipt Text:
    {raw_text}
    """

    if verbose:
        print("\n--- [3] PROMPT SENT TO OLLAMA ---")
        print(prompt)
        print("---------------------------------")
        print(f"\nRequesting JSON from qwen3.5:9b (Temperature: 0.0)...")
    else:
        print("Formatting to JSON with qwen3.5:9b...")

    try:
        # Capture the entire response object for deep inspection
        full_response = ollama.chat(
            model='qwen3.5:9b',
            messages=[{'role': 'user', 'content': prompt}],
            format='json',
            options={'temperature': 0.0}
        )

        if verbose:
            print("\n--- [4] FULL OLLAMA RESPONSE DICTIONARY ---")
            print(json.dumps(full_response, indent=2))
            print("-------------------------------------------")

        return full_response['message']['content']

    except Exception as e:
        print(f"LLM Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Verbose EasyOCR + Qwen Receipt Parser")
    parser.add_argument("image_path", help="Path to the receipt image file")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose debugging output")
    args = parser.parse_args()

    json_output = process_receipt(args.image_path, args.verbose)

    try:
        if not json_output or not json_output.strip():
            raise ValueError("Model returned an entirely empty string.")

        parsed_json = json.loads(json_output)
        print("\n--- [5] FINAL PARSED JSON ---")
        print(json.dumps(parsed_json, indent=4))

    except (json.JSONDecodeError, ValueError) as e:
        print("\n*** CRITICAL ERROR: JSON PARSING FAILED ***")
        print(f"Error Type: {type(e).__name__} - {e}")
        print(f"Raw Output Length: {len(json_output)}")
        print(f"Raw Output Content (using repr): {repr(json_output)}")
        print("\nTroubleshooting Tip: If the output is just an empty string (''), the strict `format='json'` parameter might be causing the Qwen model to instantly halt generation. Try removing `format='json',` from the ollama.chat() call to see what the model naturally wants to output.")

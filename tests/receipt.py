import argparse
import torch
import json
from PIL import Image
from transformers import DonutProcessor, VisionEncoderDecoderModel

def extract_receipt_json(image_path):
    # Load the processor and model locally
    model_name = "naver-clova-ix/donut-base-finetuned-cord-v2"
    processor = DonutProcessor.from_pretrained(model_name)
    model = VisionEncoderDecoderModel.from_pretrained(model_name)
    
    # Use GPU if available
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)

    # Load and prepare image
    image = Image.open(image_path).convert("RGB")
    pixel_values = processor(image, return_tensors="pt").pixel_values.to(device)

    # Prepare prompt for the receipt parsing task
    task_prompt = "<s_cord-v2>"
    decoder_input_ids = processor.tokenizer(task_prompt, add_special_tokens=False, return_tensors="pt").input_ids.to(device)

    # Generate output sequence
    outputs = model.generate(
        pixel_values,
        decoder_input_ids=decoder_input_ids,
        max_length=model.decoder.config.max_position_embeddings,
        pad_token_id=processor.tokenizer.pad_token_id,
        eos_token_id=processor.tokenizer.eos_token_id,
        use_cache=True,
        bad_words_ids=[[processor.tokenizer.unk_token_id]],
        return_dict_in_generate=True,
    )

    # Decode the output
    sequence = processor.batch_decode(outputs.sequences)[0]
    sequence = sequence.replace(processor.tokenizer.eos_token, "").replace(processor.tokenizer.pad_token, "")
    sequence = sequence.replace("<s_cord-v2>", "").strip() # Remove the start token
    
    # DonutProcessor has a built-in method to convert its custom string output directly to a Python dictionary
    extracted_data = processor.token2json(sequence)
    
    return extracted_data

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Local ML Receipt to JSON Parser")
    parser.add_argument("image_path", help="Path to the receipt image file")
    args = parser.parse_args()
    
    result = extract_receipt_json(args.image_path)
    
    # Print the formatted JSON output
    print(json.dumps(result, indent=4))
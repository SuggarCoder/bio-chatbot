# Qwen tokenizer deployment slot

Place the tokenizer files that exactly match the configured online Qwen model in
this directory before building the production image. At minimum, the local
Transformers loader needs `tokenizer.json` and `tokenizer_config.json`; the latter
must define the model's `chat_template`.

The application deliberately uses `local_files_only: true`. It never downloads a
tokenizer at runtime, and startup fails when a context feature is enabled with
missing or incompatible assets.

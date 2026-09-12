# RTX 4090 model checks, 2026-09-12

Host: `herkules_rtx4090`, RTX 4090 24 GiB, 32 GB system RAM.
Runtime: existing Unsloth/upstream merged llama.cpp, build `b11084-471058c6e`.
All tested profiles fully offload weights and q8_0 KV to the GPU, with flash
attention enabled. The router permits one resident model at a time.

| Public model    | Quant                   | Slots × context | Short-prompt decode, t/s |     Initial VRAM, MiB |
| --------------- | ----------------------- | --------------- | -----------------------: | --------------------: |
| qwen3.8-27b     | UD-Q4_K_M, embedded MTP | 1 × 128K        |    Existing baseline ~80 |                ~22330 |
| ling-3.0-tiny   | Q6_K                    | 4 × 128K        |                      284 | ~9182 with four slots |
| gemma-4-12b     | QAT Q4_0                | 2 × 128K        |                       97 |                 10464 |
| granite-4.2-8b  | Q6_K                    | 1 × 128K        |                      110 |                 18562 |
| mellum2-12b     | Q8_0                    | 2 × 128K        |                      255 |                 15180 |
| qwen3.6-35b-a3b | UD-IQ4_XS               | 2 × 128K        |                      180 |                 20378 |

The short probe generates 128 tokens with `ignore_eos`, temperature zero, and
an 11–12-token code-related prompt. Ling's short measurement used two slots;
its four-slot profile subsequently passed 32K and 120K concurrent prompts.
These are runtime smoke measurements, not a coding-quality benchmark or
representative sustained throughput across arbitrary tasks. VRAM values are
allocation snapshots, not a guarantee of spare memory under every workload.

`baseline.json` records short generation and forced tool-call checks.
`tuning.json` records 32K prompt tests and tool-result continuation checks.
`full-context.json` records **120000 prompt tokens plus 128 generated tokens in
every slot concurrently**, using the production router presets. All six public
profiles passed. The repeated synthetic prompt tests allocation and execution,
not retrieval accuracy at long context.

Large prefills stall decoding of other streams. Consequently the per-stream
`predicted_ms` in concurrent cold-prefill tests includes that waiting; do not
present its inverse as warmed decode throughput. A four-slot allocation is
useful for concurrent agents, but does not eliminate prefill latency.

## Speculation and held models

- Qwen 27B retains its working embedded MTP, four draft tokens per step.
- Qwen3.6 IQ4_XS omits MTP layers. `draft-mtp` fails with that file alone.
  A separately downloaded `havenoammo/.../35BA3B-MTP.gguf` also fails in this
  runtime with `GGML_ASSERT(n_expert_used_max > 0)`. The published profile
  therefore uses ordinary decoding.
- Nanbeige4.2-3B Q8_0 loads at 128K with about 16806 MiB VRAM and achieves about
  106 t/s on the short probe. Automatic tool calls and a tool-result
  continuation passed, including a 32K prompt test. Forced tool selection
  fails while initializing the grammar sampler. It is downloaded but **not
  published**, pending loader compatibility work. Its two loops use separate
  logical KV state despite sharing weights.
- Nemotron was explicitly excluded and was not downloaded.

Download checksums:

- Qwen3.6 UD-IQ4_XS: `649d7508507b84638732c4f52c24c8b15843c6dca2f3ff793ae07c14a67ebbb3`
- Nanbeige Q8_0: `837ba713ef3a3b5c9aee82e5dcba07600ea7db36ae392419f982b3bfaec04ef2`

Raw host-side logs and probes are in `/home/herkules/model-tests`.
Run `../probe.py` only during a drained maintenance window; it refuses to run
while `llama-server.service` is active. It starts private temporary servers on
port 8090 and does not change the public catalog.

## Public gateway checks

All six models returned streamed responses with usage through
`https://ai.herkules.dev/v1`. Four simultaneous Ling requests from the same
account each generated 1024 tokens in about 5.75 seconds, approximately 713
aggregate output tokens/s including request overhead with the model already
loaded. This is a short-prompt throughput check, not long-context throughput.

The initial cold-load batch exposed concurrent router autoload returning 503.
The adapter now shares one model inspection/load promise and then reserves
separate slots. A regression test simulates a router that rejects overlapping
loads. The adapter also checks other loaded models before autoload after a
restart, so it cannot evict an existing generation.

Cloudflare returns error 1010 for Python urllib's default user agent on the
public API. The smoke client uses `herkules-ai-smoke/1.0`, which passes. This is
an edge configuration limitation, separate from model authentication. Disable
Browser Integrity Check for the API hostname if default urllib clients need
access; do not disable the worker's Access policy.

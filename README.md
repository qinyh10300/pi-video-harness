# Pi Video Harness

An agentic video-generation harness that lets Pi plan, submit, monitor, and
manage local Wan video-generation jobs through the ComfyUI HTTP API.

## Architecture

```text
Pi Harness
  -> VideoHarness tools and job orchestration
  -> ComfyUI HTTP/WebSocket API
  -> Wan2.2 inference workflows
  -> generated videos and metadata
```

## Initial stack

- Pi for agent reasoning and tool orchestration
- TypeScript/Node.js for the VideoHarness service and Pi tools
- ComfyUI for workflow execution and progress reporting
- Wan2.2-TI2V-5B as the default local model
- Wan2.2 T2V/I2V-A14B as an optional high-quality backend
- DGX Spark as the initial local deployment target

## Planned first milestone

1. Submit text-to-video and image-to-video jobs from Pi.
2. Validate inputs and select an appropriate Wan workflow.
3. Track queued and running ComfyUI jobs.
4. Return generated files, previews, prompts, seeds, and run metadata.
5. Support cancellation, retries, and reproducible reruns.

## Status

Project initialization. The first implementation will target one local ComfyUI
worker and one video-generation job at a time.

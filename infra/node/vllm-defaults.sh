#!/usr/bin/env bash
# ------------------------------------------------------------------
#  Title    |  vLLM defaults for small GPUs
#  Ref      |  infra/node/README.md · bootstrap.sh step 3
#  ID       |  infra/node
# ------------------------------------------------------------------
#  Purpose  |  Arguments vLLM needs to start and report usage well on
#           |  the GPU it has, added only when ANCILE_VLLM_ARGS (from
#           |  the Controller's CreateNodeSpec.vllm, or set by hand)
#           |  does not already say otherwise.
#  How      |  Sourced by bootstrap.sh. vllm_default_args <gpu MiB>
#           |  <args> prints what to add:
#           |   - always --enable-prompt-tokens-details, so cached
#           |     prompt tokens are reported in usage;
#           |   - 12 GB or less: --gpu-memory-utilization 0.85 (0.80
#           |     at 10 GB or less) and --enforce-eager, since CUDA
#           |     graphs and the default 0.90 left no room on a 3060
#           |     and vLLM failed at start.
#  Note     |  An unknown GPU size (0) adds only the usage flag.
# ------------------------------------------------------------------

vllm_default_args() { # gpu_mib existing_args
  local mib="${1:-0}" have=" ${2:-} " out=""
  case "$have" in *" --enable-prompt-tokens-details"*) ;; *) out="--enable-prompt-tokens-details" ;; esac
  if [ "$mib" -gt 0 ] && [ "$mib" -le 12288 ]; then
    case "$have" in
      *" --gpu-memory-utilization"*) ;;
      *)
        if [ "$mib" -le 10240 ]; then out="$out --gpu-memory-utilization 0.80"
        else out="$out --gpu-memory-utilization 0.85"; fi
        ;;
    esac
    case "$have" in *" --enforce-eager"*) ;; *) out="$out --enforce-eager" ;; esac
  fi
  echo "${out# }"
}

# The first GPU's memory in MiB, 0 when it cannot be read.
gpu_memory_mib() {
  local v
  v="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -dc '0-9')"
  echo "${v:-0}"
}

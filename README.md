# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/ikun52521-max/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/ikun52521-max/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG re-encoder that squeezes 1280x720 screenshots into the smallest
possible PNG: it picks the smallest exact representation per image (palette,
grey, grey+alpha, RGB or RGBA), tries several whole-image filter strategies
and the best one per 90-row band, then compresses with a from-scratch DEFLATE
encoder (hash-chain lazy LZ77, a second pass that picks matches by true bit
cost, dynamic Huffman with length limiting) and keeps the smallest of that
and Node's zlib level 9. Fully deterministic — fixed work budgets, no clock,
no randomness — and written from scratch with only Node built-ins.

Practice set: 721,585 of 1,000,000 (house baseline fixed-paeth: 420,399).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads `/input/<id>/image.png` (`i001`–`i008`) by default and writes
`/output/<id>/image.png`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hyfder3x&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>

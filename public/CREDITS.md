# 音频素材授权

本页由 `scripts/fetch-music.js` 自动生成，数据源是 `assets/music-manifest.json`。
每条音轨的授权由人工确认后写进 manifest —— 脚本不会自行寻找或判断音源。

| 曲目 | id | 授权 | 作者 | 来源 | 时长 | 实测响度 |
| --- | --- | --- | --- | --- | --- | --- |
| 布鲁克纳《第七交响曲》第二乐章 柔板（片段） | `bruckner7-adagio` | PD | 慕尼黑音乐与戏剧大学交响乐团（Hochschule für Musik und Theater München） | [来源](https://commons.wikimedia.org/wiki/File:HSO_Bruckner-7_02.mp3) | 4:17 | -23.1 |
| 霍尔斯特《行星组曲》第七乐章 海王星，神秘者 | `holst-neptune` | PD | 伦敦交响乐团，古斯塔夫·霍尔斯特 指挥（1922–1924 年录音） | [来源](https://archive.org/details/holst-the-planets-holst-london-symphony-orchestra-1922-1924) | 5:31 | -23 |
| 霍尔斯特《行星组曲》第五乐章 土星，暮年之神（片段） | `holst-saturn` | PD | 伦敦交响乐团，古斯塔夫·霍尔斯特 指挥（1922–1924 年录音） | [来源](https://archive.org/details/holst-the-planets-holst-london-symphony-orchestra-1922-1924) | 4:37 | -22.9 |

所有音轨均已用 ffmpeg 两遍 `loudnorm` 归一化，目标 -23 LUFS、真峰 -1.5 dBTP，
以免不同来源的音量参差。原始文件未经修改地保留在 `.cache/music/`（不进版本库）。

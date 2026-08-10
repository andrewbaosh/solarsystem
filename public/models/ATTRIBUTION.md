# 着陆器模型来源

本目录的 glTF 模型来自 **NASA 3D Resources**（https://github.com/nasa/NASA-3D-Resources），
NASA 制作的媒体资料一般不受版权保护、可自由使用，详见 NASA Media Usage Guidelines
（https://www.nasa.gov/nasa-brand-center/images-and-media/）。

| 文件 | 原始名称 | 用于 |
|---|---|---|
| apollo_lm.glb | Apollo Lunar Module | 月球着陆（阿波罗 11 号剖面） |
| perseverance.glb | Mars 2020 Perseverance Rover | 火星着陆（毅力号剖面）。使用 Draco 网格压缩 |
| huygens.glb | Cassini-Huygens (A) (without Cassini) | 土卫六着陆（惠更斯号剖面） |

## 为什么火星用毅力号而不是好奇号

NASA 仓库里好奇号只有 `.blend` 源文件，没有 glTF；毅力号则直接提供了 `.glb`。
两者的着陆方式同为空中吊车，但**不能拿毅力号的模型冒充好奇号**，
所以整条 EDL 剖面一并改成了毅力号（2021-02-18，耶泽罗陨击坑）。

## 没有官方模型的天体

金星 13 号（苏联）、神舟返回舱，以及五颗虚拟方案天体，仍使用
`src/scenes/landers.js` 里按真实外形拼装的程序化模型。

## Draco 解码器

`public/draco/` 下的解码器来自本项目已有的 three 包
（`node_modules/three/examples/jsm/libs/draco/gltf/`），不是新增依赖。
只保留了 wasm 版本，编码器与纯 JS 回退已删除。

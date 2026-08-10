# 贴图来源与许可

全部贴图来自 **Solar System Scope**（https://www.solarsystemscope.com/textures/），
以 **CC BY 4.0** 许可发布（https://creativecommons.org/licenses/by/4.0/）。
本项目使用 2K 版本以控制加载体积。

作者：INOVE / Solar System Scope。素材基于 NASA 影像制作。

## 本目录文件

| 文件 | 用途 |
|---|---|
| 2k_sun.webp | 太阳自发光表面 |
| 2k_mercury.webp | 水星漫反射 |
| 2k_venus_atmosphere.webp | 金星（可见的是云顶，故用大气图而非地表图） |
| 2k_earth_daymap.webp | 地球昼面漫反射 |
| 2k_earth_nightmap.webp | 地球夜面城市灯光（emissiveMap） |
| 2k_earth_clouds.webp | 地球云层（灰度，用作 alphaMap） |
| 2k_earth_normal_map.webp | 地球法线图。原始文件是 TIFF，浏览器无法解码，已用 sips 转为 PNG |
| 2k_moon.webp | 月球漫反射 |
| 2k_mars.webp | 火星漫反射 |
| 2k_jupiter.webp | 木星漫反射 |
| 2k_saturn.webp | 土星漫反射 |
| 2k_saturn_ring_alpha.webp | 土星环，2048×125 的径向条带，带 alpha 通道 |
| 2k_uranus.webp | 天王星漫反射 |
| 2k_neptune.webp | 海王星漫反射 |
| 2k_stars_milky_way.webp | 银河星空背景（真实星图，非随机点阵） |

## 这个贴图包没有提供的

- **月球与火星的法线图**：Solar System Scope 只提供了地球的法线图。
  这两颗星球的法线是**运行时从漫反射图的亮度用 Sobel 算子生成的**，
  属于视觉近似，**不是真实地形高程**（火星的暗区如大流沙是反照率差异而非地形起伏）。
  需要考证级地形时应换成 LOLA（月球）/ MOLA（火星）高程数据生成的法线图。
- **伽利略卫星与土卫六的贴图**：包内没有，这些天体目前仍是纯色球。

## 格式说明

原始文件是 JPEG/PNG，已用 `cwebp` 转为 WebP 以缩减加载体积（7.0 MB → 3.4 MB，省 52%）：
彩色贴图 `-q 88`，法线图与环贴图用 `-lossless`（法线图上的块效应会变成可见的假凹凸）。

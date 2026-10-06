# BibTeX 宏展开与跨条目字段继承解释后端

一个**受限** BibTeX 文献库解析与有效字段分析服务，仅提供 API 与 CLI，纯本地运行。
使用 TypeScript + Node.js（>= 22.5，推荐 24+）+ SQLite（Node 内置 `node:sqlite`，无原生依赖）。

## 能力范围

- 支持条目类型：`book`、`article`、`inproceedings`、`proceedings`、`misc`，以及 `@string` 宏。
- 其他 `@` 指令（如 `@preamble`、`@comment`、`@booklet` 等）**明确拒绝**，不会跳过后声称完整导入。
- 自行解析：花括号嵌套、引号字符串、十进制字面量、宏引用、`#` 连接表达式。
  外层定界符不属于值；内层保护大小写的花括号与反斜杠文本原样保留（不当作 HTML/TeX 执行）。
- 宏名与字段名按 ASCII 大小写不敏感处理；条目键区分大小写。
  规范化后重复的宏 / 字段 / 条目会被拒绝。
- 宏允许前向引用，按整个文献库版本求值；缺失宏与宏循环返回依赖路径。
- 空字符串是有效显式值，可覆盖父条目字段。
- 资源预算：嵌套深度（64）、展开字符数（1,000,000）、依赖次数（10,000），耗尽即明确失败，不返回截断结果。
- **不做**：排版参考文献、执行 TeX、联网检索 DOI、文章推荐；不使用 eval 或现成 BibTeX 解析器。

## crossref 简化语义（明确声明）

1. 先展开 `crossref` 的值作为父条目键；
2. 子条目显式字段覆盖父条目同名有效字段；
3. 其余普通字段逐层继承；键、类型与 `crossref` 本身不向下继承，不做 `booktitle` 等隐含改名；
4. 支持多层父链、缺失父条目与循环检测，每个最终字段附实际来源条目及继承路径。

这是**受限字段继承规则**，不宣称兼容所有传统 BibTeX 样式行为。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 API（默认自动选择空闲端口，可用 --port 指定）
npm run demo       # 导入内置演示文献库并展开条目 C
```

数据目录默认为项目内 `data/`（可用环境变量 `BIB_DATA_DIR` 覆盖）。

## CLI

```
node dist/src/cli.js import <file.bib>          导入为新版本（原子事务）
node dist/src/cli.js list [--version N]         列出条目
node dist/src/cli.js show <key> [--version N]   展开条目字段（含来源链）
node dist/src/cli.js origin <key> <field>       查询单个字段来源
node dist/src/cli.js diagnostics [--version N]  查看诊断（含失败导入）
node dist/src/cli.js compare <from> <to>        比较两个版本
node dist/src/cli.js export [--version N]       导出结构化结果
node dist/src/cli.js serve [--port N]           启动 API（N=0 或省略时自动选空闲端口）
node dist/src/cli.js demo                       内置演示
```

## HTTP API

所有响应为 JSON；错误统一为 `{ "error": { "code", "message", ... } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/import` | 请求体 `{ "source": string }`，成功 201，失败 422（诊断仍保存，但不覆盖当前版本） |
| GET | `/api/entries?version=N` | 列出条目 |
| GET | `/api/entries/:key/fields?version=N` | 展开字段（`value` 展开值、`raw` 原始表达式、`sourceKey`/`path` 继承来源） |
| GET | `/api/entries/:key/fields/:field/origin?version=N` | 单字段来源链 |
| GET | `/api/diagnostics?version=N` | 诊断报告 |
| GET | `/api/compare?from=A&to=B` | 版本差异 |
| GET | `/api/export?version=N` | 结构化导出（含原文、语法结构、规则版本、展开结果） |
| GET | `/api/health` | 健康检查 |

## 错误码

`PARSE_ERROR`、`UNSUPPORTED_DIRECTIVE`、`DUPLICATE_ENTRY`、`DUPLICATE_FIELD`、`DUPLICATE_MACRO`、
`MACRO_UNDEFINED`、`MACRO_CYCLE`、`CROSSREF_MISSING`、`CROSSREF_CYCLE`、`BUDGET_EXCEEDED`、
`VALIDATION_ERROR`、`NOT_FOUND`。

## 版本与可复现性

- 每次导入在 SQLite 事务中原子创建新版本，保存原文、语法结构、规则版本（`restricted-1`）与全部展开结果。
- 修改父条目或宏即产生新版本；旧版本的报告保持可复现（查询时传 `version` 参数）。
- 失败导入保存诊断，但不更新“当前版本”指针，不覆盖已通过的库版本。
- 查询子条目只读展开结果，不会修改父条目字段。

## 演示示例

`demo/demo.bib`：

```bibtex
@string{press = {青山}}
@book{P, publisher = press, year = 2026}
@misc{C, crossref = {P}, title = {中文 {API}}, year = 2027}
```

条目 `C` 的展开结果：`publisher = "青山"`（来源 `P`，路径 `["C","P"]`），
`year = "2027"`（来源 `C`，覆盖父条目），`title = "中文 {API}"`（内层花括号保留）。

## 已知限制

- 仅支持上述 5 种条目类型与 `@string`，其余指令拒绝导入。
- 数字字面量仅支持非负十进制整数。
- 条目键内不允许逗号与空白以外的特殊分隔符；不支持字符串内的转义引号（BibTeX 标准用法是用花括号保护）。
- 继承规则为上述简化语义，不模拟具体 `.bst` 样式行为。

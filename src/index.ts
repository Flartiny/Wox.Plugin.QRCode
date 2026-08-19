import * as fs from "node:fs"
import * as path from "node:path"
import { Context, Plugin, PluginInitParams, PublicAPI, Query, QueryResponse, Result, ResultAction, WoxImage } from "@wox-launcher/wox-plugin"
import {
  appendHistory,
  buildSaveFilePath,
  cleanupCache,
  clearHistory,
  ErrorCorrectionLevel,
  formatHistoryTime,
  getQrcodeCacheDir,
  hashText,
  HistoryEntry,
  loadHistory,
  parseErrorCorrectionLevel,
  parseHistoryLimit,
  parseSize,
  removeHistory,
  resolveDownloadDirectory,
  writeQrcodePngFile
} from "./qrcode"

let api: PublicAPI

const ICON: WoxImage = {
  ImageType: "relative",
  ImageData: "images/app.png"
}

// 预览面板宽度比例：给二维码图片留出更多空间
const PREVIEW_WIDTH_RATIO = 0.55
const MAX_TITLE_LENGTH = 48
const MAX_CACHE_FILES = 30

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    await api.Log(ctx, "Info", "QRCode plugin initialized")
  },

  query: async (ctx: Context, query: Query): Promise<QueryResponse> => {
    // 选中文本查询（selection）始终走生成逻辑；qrlist 仅由输入关键词触发
    if (query.Type !== "selection" && query.TriggerKeyword === "qrlist") {
      return handleQrList(query)
    }
    return handleQrcode(ctx, query)
  }
}

// ============ qrcode 命令：生成二维码 ============

async function handleQrcode(ctx: Context, query: Query): Promise<QueryResponse> {
  const raw = query.Type === "selection" ? query.Selection?.Text : query.Search
  const text = (raw ?? "").trim()
  if (!text) {
    return { Results: [buildHelpResult()] }
  }

  try {
    const [options, historyLimitValue] = await Promise.all([loadOptions(ctx), api.GetSetting(ctx, "historyLimit")])
    // 缓存写入 Wox 数据目录，避免开发模式下触发 dist 监视导致的插件自动重载
    const cacheDir = getQrcodeCacheDir()
    cleanupCache(cacheDir, MAX_CACHE_FILES)

    const imagePath = await writeQrcodePngFile(cacheDir, text, options)
    // 记录历史：相同内容去重并提前，超过上限时淘汰最旧
    appendHistory(text, new Date(), parseHistoryLimit(historyLimitValue))
    return {
      Results: [await buildQrcodeResult(text, imagePath, options)],
      Layout: { ResultPreviewWidthRatio: PREVIEW_WIDTH_RATIO }
    }
  } catch (error) {
    await api.Log(ctx, "Error", error instanceof Error ? error.stack || error.message : String(error))
    return {
      Results: [
        {
          Id: "qrcode-error",
          Title: "生成二维码失败",
          SubTitle: "内容过长或包含无法编码的字符，请尝试缩短文本",
          Icon: ICON
        }
      ]
    }
  }
}

// ============ qrlist 命令：查看历史生成记录 ============

async function handleQrList(query: Query): Promise<QueryResponse> {
  // 支持输入 qrlist <关键词> 过滤历史
  const search = (query.Search ?? "").trim().toLowerCase()
  const entries = loadHistory().filter(entry => !search || entry.text.toLowerCase().includes(search))

  if (entries.length === 0) {
    return { Results: [buildEmptyHistoryResult(search)] }
  }

  const results = await Promise.all(entries.map(entry => buildHistoryResult(entry)))
  // 仅在全量列表时提供清空入口，搜索过滤模式下避免误操作
  if (!search) {
    results.push(buildClearHistoryResult())
  }
  return { Results: results, Layout: { ResultPreviewWidthRatio: PREVIEW_WIDTH_RATIO } }
}

// 历史条目结果：缓存图片仍在时展示真实预览，否则退回文本预览
async function buildHistoryResult(entry: HistoryEntry): Promise<Result> {
  const cacheDir = getQrcodeCacheDir()
  const cachePath = path.join(cacheDir, `qr-${hashText(entry.text)}.png`)
  const hasCache = fs.existsSync(cachePath)
  const timeLabel = formatHistoryTime(entry.createdAt, new Date())
  const icon: WoxImage = hasCache ? { ImageType: "absolute", ImageData: cachePath } : ICON

  return {
    Id: `qrlist-${hashText(entry.text)}`,
    Title: truncateText(entry.text, MAX_TITLE_LENGTH),
    SubTitle: `${timeLabel} · ${entry.text.length} 字符 · 回车复制图片`,
    Icon: icon,
    Score: 100,
    Tails: [{ Type: "text", Text: "历史" }],
    Preview: hasCache
      ? {
          PreviewType: "image",
          // image 预览的 PreviewData 必须带类型前缀（如 absolute:），纯路径会被解析成错误的 ImageType
          PreviewData: `absolute:${cachePath}`,
          PreviewTags: [
            { Label: timeLabel, Tooltip: "生成时间" },
            { Label: `${entry.text.length} chars`, Tooltip: "内容长度" }
          ],
          PreviewProperties: {}
        }
      : {
          PreviewType: "text",
          PreviewData: entry.text,
          PreviewProperties: {}
        },
    Actions: [buildCopyImageAction(entry.text), buildSaveAsPngAction(entry.text, "qrlist "), buildCopyTextAction(entry.text), buildRemoveHistoryAction(entry.text)]
  }
}

// ============ 结果构建 ============

function buildHelpResult(): Result {
  return {
    Id: "qrcode-help",
    Title: "二维码生成器",
    SubTitle: "输入内容生成二维码：qrcode 文本或链接，回车复制图片；输入 qrlist 查看历史",
    Icon: ICON,
    Preview: {
      PreviewType: "text",
      PreviewData:
        "用法：\n  输入 qrcode <内容> 生成二维码\n  输入 qrlist [关键词] 查看历史生成记录\n\n操作（生成结果）：\n  回车       复制二维码图片到剪贴板\n  Ctrl+S     保存为 PNG 到目录\n  Ctrl+C     复制二维码内容文本\n\n操作（历史列表）：\n  回车       复制二维码图片到剪贴板\n  Ctrl+S     保存为 PNG 到目录\n  Ctrl+C     复制二维码内容文本\n  Ctrl+D     从历史中删除该条记录\n\n设置：\n  尺寸、容错等级、保存目录、历史条数可在插件设置中调整",
      PreviewProperties: {}
    }
  }
}

function buildEmptyHistoryResult(search: string): Result {
  return {
    Id: "qrlist-empty",
    Title: search ? "没有匹配的历史记录" : "暂无历史记录",
    SubTitle: search ? `未找到包含「${search}」的生成记录` : "输入 qrcode <内容> 生成二维码后，记录会显示在这里",
    Icon: ICON
  }
}

function buildClearHistoryResult(): Result {
  return {
    Id: "qrlist-clear",
    Title: "清空历史记录",
    SubTitle: "删除全部历史记录，此操作不可撤销",
    Icon: ICON,
    Score: 1,
    Actions: [
      {
        Name: "清空历史记录",
        IsDefault: true,
        Hotkey: "Enter",
        Action: async (actionCtx: Context) => {
          clearHistory()
          await api.Notify(actionCtx, "历史记录已清空")
          await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: "qrlist " })
        }
      }
    ]
  }
}

async function buildQrcodeResult(text: string, imagePath: string, options: { width: number; errorCorrectionLevel: ErrorCorrectionLevel }): Promise<Result> {
  const levelLabel: Record<ErrorCorrectionLevel, string> = { L: "L", M: "M", Q: "Q", H: "H" }
  const image: WoxImage = { ImageType: "absolute", ImageData: imagePath }

  return {
    Id: `qrcode-${path.basename(imagePath)}`,
    Title: `二维码: ${truncateText(text, MAX_TITLE_LENGTH)}`,
    SubTitle: `${text.length} 字符 · ${options.width}px · 容错 ${levelLabel[options.errorCorrectionLevel]} · 回车复制图片`,
    Icon: image,
    Score: 100,
    Tails: [{ Type: "text", Text: "PNG" }],
    Preview: {
      PreviewType: "image",
      // image 预览的 PreviewData 必须带类型前缀（如 absolute:），纯路径会被解析成错误的 ImageType
      PreviewData: `absolute:${imagePath}`,
      PreviewTags: [
        { Label: `${options.width}×${options.width}`, Tooltip: "图片尺寸" },
        { Label: `${text.length} chars`, Tooltip: "内容长度" },
        { Label: `EC ${levelLabel[options.errorCorrectionLevel]}`, Tooltip: "容错等级" }
      ],
      PreviewProperties: {}
    },
    Actions: [buildCopyImageAction(text), buildSaveAsPngAction(text, "qrcode "), buildCopyTextAction(text)]
  }
}

// ============ 公共操作 ============

// 复制二维码图片：缓存缺失时按需重新生成，保证任何历史条目都可复制
function buildCopyImageAction(text: string): ResultAction {
  return {
    Name: "复制二维码图片",
    IsDefault: true,
    Hotkey: "Enter",
    Action: async (actionCtx: Context) => {
      const options = await loadOptions(actionCtx)
      const imagePath = await writeQrcodePngFile(getQrcodeCacheDir(), text, options)
      const image: WoxImage = { ImageType: "absolute", ImageData: imagePath }
      await api.Copy(actionCtx, { type: "image", text: "", woxImage: image })
      await api.Notify(actionCtx, "二维码图片已复制到剪贴板")
    }
  }
}

// 保存为 PNG：保存后把搜索框重置到所属命令，方便连续操作
function buildSaveAsPngAction(text: string, nextQuery: string): ResultAction {
  return {
    Name: "保存为 PNG",
    Hotkey: "Ctrl+S",
    Action: async (actionCtx: Context) => {
      const directory = resolveDownloadDirectory(await api.GetSetting(actionCtx, "downloadDirectory"))
      fs.mkdirSync(directory, { recursive: true })
      const savePath = buildSaveFilePath(directory, new Date())
      const options = await loadOptions(actionCtx)
      const imagePath = await writeQrcodePngFile(getQrcodeCacheDir(), text, options)
      fs.copyFileSync(imagePath, savePath)
      await api.Notify(actionCtx, `已保存: ${savePath}`)
      await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: nextQuery })
    }
  }
}

function buildCopyTextAction(text: string): ResultAction {
  return {
    Name: "复制内容文本",
    Hotkey: "Ctrl+C",
    Action: async (actionCtx: Context) => {
      await api.Copy(actionCtx, { type: "text", text })
      await api.Notify(actionCtx, "二维码内容已复制到剪贴板")
    }
  }
}

// 从历史中删除单条记录：删除后回到 qrlist 刷新列表
function buildRemoveHistoryAction(text: string): ResultAction {
  return {
    Name: "从历史中删除",
    Hotkey: "Ctrl+D",
    Action: async (actionCtx: Context) => {
      removeHistory(text)
      await api.Notify(actionCtx, "已从历史中删除")
      await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: "qrlist " })
    }
  }
}

// ============ 工具函数 ============

async function loadOptions(ctx: Context): Promise<{ width: number; errorCorrectionLevel: ErrorCorrectionLevel }> {
  const [sizeValue, levelValue] = await Promise.all([api.GetSetting(ctx, "size"), api.GetSetting(ctx, "errorCorrectionLevel")])
  return {
    width: parseSize(sizeValue),
    errorCorrectionLevel: parseErrorCorrectionLevel(levelValue)
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength - 1)}…`
}

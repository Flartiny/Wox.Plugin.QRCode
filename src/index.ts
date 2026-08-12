import * as fs from "fs"
import * as path from "path"
import { Context, Plugin, PluginInitParams, PublicAPI, Query, QueryResponse, Result, WoxImage } from "@wox-launcher/wox-plugin"
import { buildSaveFilePath, cleanupCache, ErrorCorrectionLevel, parseErrorCorrectionLevel, parseSize, resolveDownloadDirectory, writeQrcodePngFile } from "./qrcode"

let api: PublicAPI
let pluginDirectory = ""

const ICON: WoxImage = {
  ImageType: "relative",
  ImageData: "images/app.svg"
}

// 预览面板宽度比例：给二维码图片留出更多空间
const PREVIEW_WIDTH_RATIO = 0.55
const MAX_TITLE_LENGTH = 48
const MAX_CACHE_FILES = 30

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    pluginDirectory = initParams.PluginDirectory
    await api.Log(ctx, "Info", "QRCode plugin initialized")
  },

  query: async (ctx: Context, query: Query): Promise<QueryResponse> => {
    const raw = query.Type === "selection" ? query.Selection?.Text : query.Search
    const text = (raw ?? "").trim()
    if (!text) {
      return { Results: [buildHelpResult()] }
    }

    try {
      const options = await loadOptions(ctx)
      const cacheDir = path.join(pluginDirectory, ".cache")
      cleanupCache(cacheDir, MAX_CACHE_FILES)

      const imagePath = await writeQrcodePngFile(cacheDir, text, options)
      return {
        Results: [await buildQrcodeResult(ctx, text, imagePath, options)],
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
}

function buildHelpResult(): Result {
  return {
    Id: "qrcode-help",
    Title: "二维码生成器",
    SubTitle: "输入内容生成二维码：qrcode 文本或链接，回车复制图片",
    Icon: ICON,
    Preview: {
      PreviewType: "text",
      PreviewData:
        "用法：\n  输入 qrcode <内容> 生成二维码\n\n操作：\n  回车       复制二维码图片到剪贴板\n  Ctrl+S     保存为 PNG 到目录\n  Ctrl+C     复制二维码内容文本\n\n设置：\n  尺寸、容错等级、保存目录可在插件设置中调整",
      PreviewProperties: {}
    }
  }
}

async function loadOptions(ctx: Context): Promise<{ width: number; errorCorrectionLevel: ErrorCorrectionLevel }> {
  const [sizeValue, levelValue] = await Promise.all([api.GetSetting(ctx, "size"), api.GetSetting(ctx, "errorCorrectionLevel")])
  return {
    width: parseSize(sizeValue),
    errorCorrectionLevel: parseErrorCorrectionLevel(levelValue)
  }
}

async function buildQrcodeResult(ctx: Context, text: string, imagePath: string, options: { width: number; errorCorrectionLevel: ErrorCorrectionLevel }): Promise<Result> {
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
      PreviewData: imagePath,
      PreviewTags: [
        { Label: `${options.width}×${options.width}`, Tooltip: "图片尺寸" },
        { Label: `${text.length} chars`, Tooltip: "内容长度" },
        { Label: `EC ${levelLabel[options.errorCorrectionLevel]}`, Tooltip: "容错等级" }
      ],
      PreviewProperties: {}
    },
    Actions: [
      {
        Name: "复制二维码图片",
        IsDefault: true,
        Hotkey: "Enter",
        Action: async (actionCtx: Context) => {
          await api.Copy(actionCtx, { type: "image", text: "", woxImage: image })
          await api.Notify(actionCtx, "二维码图片已复制到剪贴板")
        }
      },
      {
        Name: "保存为 PNG",
        Hotkey: "Ctrl+S",
        Action: async (actionCtx: Context) => {
          const directory = resolveDownloadDirectory(await api.GetSetting(actionCtx, "downloadDirectory"))
          fs.mkdirSync(directory, { recursive: true })
          const savePath = buildSaveFilePath(directory, new Date())
          fs.copyFileSync(imagePath, savePath)
          await api.Notify(actionCtx, `已保存: ${savePath}`)
          await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: "qrcode " })
        }
      },
      {
        Name: "复制内容文本",
        Hotkey: "Ctrl+C",
        Action: async (actionCtx: Context) => {
          await api.Copy(actionCtx, { type: "text", text })
          await api.Notify(actionCtx, "二维码内容已复制到剪贴板")
        }
      }
    ]
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength - 1)}…`
}

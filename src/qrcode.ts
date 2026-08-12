import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import QRCode from "qrcode"

export type ErrorCorrectionLevel = "L" | "M" | "Q" | "H"

export interface QrcodeOptions {
  width: number
  errorCorrectionLevel: ErrorCorrectionLevel
}

// Wox 数据目录：与插件目录隔离
// 开发模式下 Wox 从插件 dist 目录加载并监视文件变化，写入插件目录会触发自动重载，
// 因此缓存必须放到独立位置。
export function getWoxDataDir(): string {
  const appData = process.env.APPDATA
  if (process.platform === "win32" && appData) {
    return path.join(appData, "Wox", "Data")
  }

  const home = process.env.HOME || process.env.USERPROFILE || "~"
  return path.join(home, ".wox", "data")
}

// 二维码缓存目录：Wox 数据目录下的独立子目录
export function getQrcodeCacheDir(): string {
  return path.join(getWoxDataDir(), "qrcode-cache")
}

const DEFAULT_WIDTH = 512
const MAX_WIDTH = 4096
const MIN_WIDTH = 64

// 解析尺寸设置：非法值回退默认 512，超出范围截断
export function parseSize(value: string | undefined): number {
  const size = parseInt(value ?? "", 10)
  if (Number.isNaN(size) || size < MIN_WIDTH) {
    return DEFAULT_WIDTH
  }
  return Math.min(size, MAX_WIDTH)
}

// 解析容错等级设置：非法值回退 M
export function parseErrorCorrectionLevel(value: string | undefined): ErrorCorrectionLevel {
  const level = (value ?? "").trim().toUpperCase()
  return level === "L" || level === "Q" || level === "H" ? level : "M"
}

// 文本摘要，用于生成稳定且安全的缓存文件名
// 文件名用途无安全要求，但统一使用 sha256 避免弱哈希告警
export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)
}

// 解析保存目录设置：空值回退到系统下载目录
export function resolveDownloadDirectory(setting: string | undefined): string {
  const trimmed = (setting ?? "").trim()
  if (trimmed) {
    return trimmed
  }

  const home = process.env.USERPROFILE || process.env.HOME || ""
  if (home) {
    return path.join(home, "Downloads")
  }
  return "."
}

// 生成二维码 PNG 数据
export async function generateQrcodePng(text: string, options: QrcodeOptions): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: "png",
    width: options.width,
    errorCorrectionLevel: options.errorCorrectionLevel,
    margin: 2
  })
}

// 将二维码写入缓存目录（按文本摘要复用文件），返回图片绝对路径
export async function writeQrcodePngFile(cacheDir: string, text: string, options: QrcodeOptions): Promise<string> {
  const filePath = path.join(cacheDir, `qr-${hashText(text)}.png`)
  if (fs.existsSync(filePath)) {
    return filePath
  }

  fs.mkdirSync(cacheDir, { recursive: true })
  // 先写临时文件再重命名，避免并发查询时读到半个文件
  const tmpPath = `${filePath}.tmp`
  const buffer = await generateQrcodePng(text, options)
  fs.writeFileSync(tmpPath, buffer)
  fs.renameSync(tmpPath, filePath)
  return filePath
}

// 清理缓存目录：按修改时间保留最近的 maxFiles 个二维码文件
export function cleanupCache(cacheDir: string, maxFiles = 30): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return
  }

  const files = entries
    .filter(entry => entry.isFile() && entry.name.startsWith("qr-") && entry.name.endsWith(".png"))
    .map(entry => {
      const stat = fs.statSync(path.join(cacheDir, entry.name))
      return { name: entry.name, mtime: stat.mtimeMs }
    })
    .sort((left, right) => right.mtime - left.mtime)

  for (const file of files.slice(maxFiles)) {
    fs.rmSync(path.join(cacheDir, file.name), { force: true })
  }
}

// 构造保存文件名：qrcode_YYYYMMDD_HHmmss.png，重名时自动追加序号
export function buildSaveFilePath(directory: string, now: Date): string {
  const stamp = formatTimestamp(now)
  let filePath = path.join(directory, `qrcode_${stamp}.png`)
  let counter = 1
  while (fs.existsSync(filePath)) {
    filePath = path.join(directory, `qrcode_${stamp}_${counter}.png`)
    counter += 1
  }
  return filePath
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), "_", pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("")
}

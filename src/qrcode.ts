import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
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

// ============ 历史记录 ============

// 历史记录条目：生成内容与时间戳
// 缓存文件名是内容哈希，无法还原文本，因此历史独立存储为 JSON 文件
export interface HistoryEntry {
  text: string
  createdAt: number
}

export const DEFAULT_HISTORY_LIMIT = 50
const MIN_HISTORY_LIMIT = 10
const MAX_HISTORY_LIMIT = 200

// 历史记录文件：Wox 数据目录下与缓存平级的独立文件
// 历史与缓存分离：缓存最多保留 30 张图，历史可保留更多条文本记录
export function getHistoryFilePath(): string {
  return path.join(getWoxDataDir(), "qrcode-history.json")
}

// 解析历史条数设置：非法值回退默认 50，超出范围截断
// 默认值与其他设置解析函数保持一致：回退到常量默认值
export function parseHistoryLimit(value: string | undefined): number {
  const limit = parseInt(value ?? "", 10)
  if (Number.isNaN(limit) || limit < MIN_HISTORY_LIMIT) {
    return DEFAULT_HISTORY_LIMIT
  }
  return Math.min(limit, MAX_HISTORY_LIMIT)
}

// 读取历史记录：文件不存在或内容损坏时返回空数组
// filePath 参数便于测试注入临时路径，生产环境使用默认路径
export function loadHistory(filePath = getHistoryFilePath()): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"))
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(isHistoryEntry)
  } catch {
    return []
  }
}

// 记录一次生成：相同文本去重并提到最前（最近使用优先），保留最近 limit 条
// 返回写入后的完整列表
export function appendHistory(text: string, now: Date, limit: number, filePath = getHistoryFilePath()): HistoryEntry[] {
  const entries = loadHistory(filePath).filter(entry => entry.text !== text)
  entries.unshift({ text, createdAt: now.getTime() })
  const trimmed = entries.slice(0, limit)
  writeHistory(filePath, trimmed)
  return trimmed
}

// 从历史中删除指定文本对应的记录，返回删除后的列表
export function removeHistory(text: string, filePath = getHistoryFilePath()): HistoryEntry[] {
  const entries = loadHistory(filePath).filter(entry => entry.text !== text)
  writeHistory(filePath, entries)
  return entries
}

// 清空全部历史记录
export function clearHistory(filePath = getHistoryFilePath()): void {
  try {
    fs.rmSync(filePath, { force: true })
  } catch {
    // 清理失败不影响主流程
  }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return typeof value === "object" && value !== null && typeof (value as HistoryEntry).text === "string" && typeof (value as HistoryEntry).createdAt === "number"
}

// 写历史文件：先写临时文件再重命名，避免并发查询读到半个文件（与缓存写入一致）
function writeHistory(filePath: string, entries: HistoryEntry[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2))
  fs.renameSync(tmpPath, filePath)
}

// 格式化历史时间：今天显示「今天 HH:mm」，昨天显示「昨天 HH:mm」，更早显示「YYYY-MM-DD HH:mm」
export function formatHistoryTime(timestamp: number, now: Date): string {
  const date = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, "0")
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)
  if (dayDiff === 0) {
    return `今天 ${time}`
  }
  if (dayDiff === 1) {
    return `昨天 ${time}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

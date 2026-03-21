import { readFile, writeFile } from 'node:fs/promises'

/**
 * @typedef {'ss'} NodeType
 */

/**
 * @typedef {Object} ProbeNode
 * @property {string} id
 * @property {string} name
 * @property {NodeType} type
 * @property {string} server
 * @property {number} port
 * @property {string} method
 * @property {string} password
 * @property {string=} binary
 * @property {string=} remarks
 */

/**
 * @param {string} filePath
 * @returns {Promise<ProbeNode[]>}
 */
export async function loadNodes(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const data = JSON.parse(raw)

  if (!Array.isArray(data)) {
    throw new Error('配置文件必须是节点数组')
  }

  return data.map(validateNode)
}

/**
 * @param {string} filePath
 * @param {string} nodeId
 * @param {string} server
 */
export async function updateNodeServer(filePath, nodeId, server) {
  const nextServer = typeof server === 'string' ? server.trim() : ''
  if (!nextServer) {
    throw new Error('server 不能为空')
  }

  const raw = await readFile(filePath, 'utf8')
  const data = JSON.parse(raw)

  if (!Array.isArray(data)) {
    throw new Error('配置文件必须是节点数组')
  }

  const index = data.findIndex(item => {
    if (!item || typeof item !== 'object') {
      return false
    }

    const record = /** @type {Record<string, unknown>} */ (item)
    const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id : String(record.name ?? '')
    return id === nodeId
  })

  if (index < 0) {
    throw new Error(`未找到节点: ${nodeId}`)
  }

  const record = /** @type {Record<string, unknown>} */ (data[index])
  record.server = nextServer

  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')

  return validateNode(record)
}

/**
 * @param {unknown} value
 * @returns {ProbeNode}
 */
function validateNode(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('节点配置格式错误')
  }

  const node = /** @type {Record<string, unknown>} */ (value)
  const requiredTextFields = ['name', 'type', 'server', 'password']

  for (const field of requiredTextFields) {
    if (typeof node[field] !== 'string' || node[field].trim() === '') {
      throw new Error(`节点字段无效: ${field}`)
    }
  }

  const id = typeof node.id === 'string' && node.id.trim() !== '' ? node.id : String(node.name)
  const method = resolveMethod(node)

  if (node.type !== 'ss') {
    throw new Error(`不支持的节点类型: ${String(node.type)}`)
  }

  if (typeof node.port !== 'number' || !Number.isInteger(node.port) || node.port <= 0) {
    throw new Error('节点字段无效: port')
  }

  return /** @type {ProbeNode} */ ({
    id,
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    method,
    password: node.password,
    binary: asOptionalText(node.binary),
    remarks: asOptionalText(node.remarks),
  })
}

/**
 * @param {unknown} value
 */
function asOptionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * @param {Record<string, unknown>} node
 * @param {string[]} aliases
 */
function resolveMethod(node) {
  const method = asOptionalText(node.method)
  if (method) {
    return method
  }

  const cipher = asOptionalText(node.cipher)
  if (cipher) {
    return cipher
  }

  throw new Error('节点字段无效: method/cipher')
}

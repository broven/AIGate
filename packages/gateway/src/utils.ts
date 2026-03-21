const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function nanoid(size = 21): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  let id = ''
  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i]! % ALPHABET.length]
  }
  return id
}

export function hashKey(key: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(key)
  return hasher.digest('hex')
}

export function generateApiKey(): string {
  return `sk-gate-${nanoid(32)}`
}

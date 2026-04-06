import { resolve } from 'path'
import { config } from '../config.js'

export function memoryRoot(): string {
  return resolve(process.cwd(), config.memory.dir)
}

export function masterIndexPath(): string {
  return resolve(memoryRoot(), 'index.md')
}

export function treeRoot(tree: 'buckets' | 'persons' | 'chats'): string {
  return resolve(memoryRoot(), tree)
}

export function treeIndexPath(
  tree: 'buckets' | 'persons' | 'chats',
): string {
  return resolve(treeRoot(tree), 'index.md')
}

export function entityDir(
  tree: 'buckets' | 'persons' | 'chats',
  slug: string,
): string {
  return resolve(treeRoot(tree), slug)
}

export function entityIndexPath(
  tree: 'buckets' | 'persons' | 'chats',
  slug: string,
): string {
  return resolve(entityDir(tree, slug), 'index.md')
}

export function entityFilePath(
  tree: 'buckets' | 'persons' | 'chats',
  slug: string,
  filename: string,
): string {
  return resolve(entityDir(tree, slug), filename)
}

export function digestStatePath(): string {
  return resolve(memoryRoot(), 'digest-state.json')
}

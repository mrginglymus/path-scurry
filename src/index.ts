import LRUCache from 'lru-cache'
import { posix, win32 } from 'path'

import { lstatSync, readdirSync, readlinkSync } from 'fs'
import { lstat, readdir, readlink } from 'fs/promises'

import { Dirent, Stats } from 'fs'

// turn something like //?/c:/ into c:\
const uncDriveRegexp = /^\\\\\?\\([a-z]:)\\?$/
const uncToDrive = (rootPath: string): string =>
  rootPath.replace(/\//g, '\\').replace(uncDriveRegexp, '$1:\\')

// if it's a drive letter path, return the drive letter plus \
// otherwise, return \
const driveCwd = (c: string): string =>
  (c.match(/^([a-z]):(?:\\|\/|$)/)?.[1] || '') + '\\'
const eitherSep = /[\\\/]/

const UNKNOWN = 0 // may not even exist, for all we know
const IFIFO = 0b0001
const IFCHR = 0b0010
const IFDIR = 0b0100
const IFBLK = 0b0110
const IFREG = 0b1000
const IFLNK = 0b1010
const IFSOCK = 0b1100
const IFMT = 0b1111

// mask to unset low 4 bits
const IFMT_UNKNOWN = ~IFMT
// set after successfully calling readdir() and getting entries.
const READDIR_CALLED = 0b0001_0000
// set if an entry (or one of its parents) is definitely not a dir
const ENOTDIR = 0b0010_0000
// set if an entry (or one of its parents) does not exist
// (can also be set on lstat errors like EACCES or ENAMETOOLONG)
const ENOENT = 0b0100_0000
// cannot have child entries -- also verify &IFMT is either IFDIR or IFLNK
const ENOCHILD = ENOTDIR | ENOENT
// set if we fail to readlink
const ENOREADLINK = 0b1000_0000
const TYPEMASK = 0b1111_1111

const entToType = (s: Dirent | Stats) =>
  s.isFile()
    ? IFREG
    : s.isDirectory()
    ? IFDIR
    : s.isSymbolicLink()
    ? IFLNK
    : s.isCharacterDevice()
    ? IFCHR
    : s.isBlockDevice()
    ? IFBLK
    : s.isSocket()
    ? IFSOCK
    : s.isFIFO()
    ? IFIFO
    : UNKNOWN

/**
 * Options that may be provided to the Path constructor
 */
export interface PathOpts {
  fullpath?: string
  parent?: PathBase
}

/**
 * An LRUCache for storing resolved path strings or Path objects.
 * @internal
 */
export class ResolveCache<T> extends LRUCache<string, T> {
  constructor() {
    super({ max: 256 })
  }
}

// In order to prevent blowing out the js heap by allocating hundreds of
// thousands of Path entries when walking extremely large trees, the "children"
// in this tree are represented by storing an array of Path entries in an
// LRUCache, indexed by the parent.  At any time, Path.children() may return an
// empty array, indicating that it doesn't know about any of its children, and
// thus has to rebuild that cache.  This is fine, it just means that we don't
// benefit as much from having the cached entries, but huge directory walks
// don't blow out the stack, and smaller ones are still as fast as possible.
//
//It does impose some complexity when building up the readdir data, because we
//need to pass a reference to the children array that we started with.

/**
 * an LRUCache for storing child entries.
 * @internal
 */
export class ChildrenCache extends LRUCache<PathBase, Children> {
  constructor(maxSize: number = 16 * 1024) {
    super({
      maxSize,
      // parent + children
      sizeCalculation: a => a.length + 1,
    })
  }
}

/**
 * Array of Path objects, plus a marker indicating the first provisional entry
 *
 * @internal
 */
export type Children = PathBase[] & { provisional: number }

/**
 * Path objects are sort of like a super-powered
 * {@link https://nodejs.org/docs/latest/api/fs.html#class-fsdirent fs.Dirent}
 *
 * Each one represents a single filesystem entry on disk, which may or may not
 * exist. It includes methods for reading various types of information via
 * lstat, readlink, and readdir, and caches all information to the greatest
 * degree possible.
 *
 * Note that fs operations that would normally throw will instead return an
 * "empty" value. This is in order to prevent excessive overhead from error
 * stack traces.
 */
export abstract class PathBase implements Dirent {
  /**
   * the basename of this path
   */
  name: string
  /**
   * the Path entry corresponding to the path root.
   *
   * @internal
   */
  root: PathBase
  /**
   * All roots found within the current PathWalker family
   *
   * @internal
   */
  roots: { [k: string]: PathBase }
  /**
   * a reference to the parent path, or undefined in the case of root entries
   *
   * @internal
   */
  parent?: PathBase
  /**
   * boolean indicating whether paths are compared case-insensitively
   * @internal
   */
  nocase: boolean

  /**
   * the string or regexp used to split paths. On posix, it is `'/'`, and on
   * windows it is a RegExp matching either `'/'` or `'\\'`
   */
  abstract splitSep: string | RegExp
  /**
   * The path separator string to use when joining paths
   */
  abstract sep: string

  #matchName: string
  #fullpath?: string
  #type: number
  #resolveCache: ResolveCache<PathBase>
  #children: ChildrenCache
  #linkTarget?: PathBase

  /**
   * Do not create new Path objects directly.  They should always be accessed
   * via the PathWalker class or other methods on the Path class.
   *
   * @internal
   */
  constructor(
    name: string,
    type: number = UNKNOWN,
    root: PathBase | undefined,
    roots: { [k: string]: PathBase },
    nocase: boolean,
    children: ChildrenCache,
    opts: PathOpts
  ) {
    this.name = name

    this.#matchName = nocase ? name.toLowerCase() : name
    this.#type = type & TYPEMASK
    this.nocase = nocase
    this.roots = roots
    this.root = root || this
    this.#resolveCache = new ResolveCache()
    this.#children = children
    Object.assign(this, opts)
  }

  /**
   * @internal
   */
  abstract getRootString(path: string): string
  /**
   * @internal
   */
  abstract getRoot(rootPath: string): PathBase
  /**
   * @internal
   */
  abstract newChild(name: string, type?: number, opts?: PathOpts): PathBase

  /**
   * @internal
   */
  childrenCache() {
    return this.#children
  }

  /**
   * Get the Path object referenced by the string path, resolved from this Path
   */
  resolve(path?: string): PathBase {
    if (!path) {
      return this
    }
    const cached = this.#resolveCache.get(path)
    if (cached) {
      return cached
    }
    const rootPath = this.getRootString(path)
    const dir = path.substring(rootPath.length)
    const dirParts = dir.split(this.splitSep)
    const result: PathBase = rootPath
      ? this.getRoot(rootPath).#resolveParts(dirParts)
      : this.#resolveParts(dirParts)
    this.#resolveCache.set(path, result)
    return result
  }

  #resolveParts(dirParts: string[]) {
    let p: PathBase = this
    for (const part of dirParts) {
      p = p.child(part)
    }
    return p
  }

  /**
   * Returns the cached children Path objects, if still available.  If they
   * have fallen out of the cache, then returns an empty array, and resets the
   * READDIR_CALLED bit, so that future calls to readdir() will require an fs
   * lookup.
   *
   * @internal
   */
  children(): Children {
    const cached = this.#children.get(this)
    if (cached) {
      return cached
    }
    const children: Children = Object.assign([], { provisional: 0 })
    this.#children.set(this, children)
    this.#type &= ~READDIR_CALLED
    return children
  }

  /**
   * Resolves a path portion and returns or creates the child Path.
   *
   * Returns `this` if pathPart is `''` or `'.'`, or `parent` if pathPart is
   * `'..'`.
   *
   * This should not be called directly.  If `pathPart` contains any path
   * separators, it will lead to unsafe undefined behavior.
   *
   * Use `Path.resolve()` instead.
   *
   * @internal
   */
  child(pathPart: string): PathBase {
    if (pathPart === '' || pathPart === '.') {
      return this
    }
    if (pathPart === '..') {
      return this.parent || this
    }

    // find the child
    const children = this.children()
    const name = this.nocase ? pathPart.toLowerCase() : pathPart
    for (const p of children) {
      if (p.#matchName === name) {
        return p
      }
    }

    // didn't find it, create provisional child, since it might not
    // actually exist.  If we know the parent isn't a dir, then
    // in fact it CAN'T exist.
    const s = this.parent ? this.sep : ''
    const fullpath = this.#fullpath
      ? this.#fullpath + s + pathPart
      : undefined
    const pchild = this.newChild(pathPart, UNKNOWN)
    pchild.parent = this
    pchild.#fullpath = fullpath

    if (this.#cannotReaddir()) {
      pchild.#type |= ENOENT
    }

    // don't have to update provisional, because if we have real children,
    // then provisional is set to children.length, otherwise a lower number
    children.push(pchild)
    return pchild
  }

  /**
   * The fully resolved path string for this Path entry
   */
  fullpath(): string {
    if (this.#fullpath !== undefined) {
      return this.#fullpath
    }
    const name = this.name
    const p = this.parent
    if (!p) {
      return (this.#fullpath = this.name)
    }
    const pv = p.fullpath()
    const fp = pv + (!p.parent ? '' : this.sep) + name
    return (this.#fullpath = fp)
  }

  /**
   * Is the Path of an unknown type?
   *
   * Note that we might know *something* about it if there has been a previous
   * filesystem operation, for example that it does not exist, or is not a
   * link, or whether it has child entries.
   */
  isUnknown(): boolean {
    return (this.#type & IFMT) === UNKNOWN
  }

  /**
   * Is the Path a regular file?
   */
  isFile(): boolean {
    return (this.#type & IFMT) === IFREG
  }

  /**
   * Is the Path a directory?
   */
  isDirectory(): boolean {
    return (this.#type & IFMT) === IFDIR
  }

  /**
   * Is the path a character device?
   */
  isCharacterDevice(): boolean {
    return (this.#type & IFMT) === IFCHR
  }

  /**
   * Is the path a block device?
   */
  isBlockDevice(): boolean {
    return (this.#type & IFMT) === IFBLK
  }

  /**
   * Is the path a FIFO pipe?
   */
  isFIFO(): boolean {
    return (this.#type & IFMT) === IFIFO
  }

  /**
   * Is the path a socket?
   */
  isSocket(): boolean {
    return (this.#type & IFMT) === IFSOCK
  }

  /**
   * Is the path a symbolic link?
   */
  isSymbolicLink(): boolean {
    return (this.#type & IFLNK) === IFLNK
  }

  #cannotReaddir() {
    if (this.#type & ENOCHILD) return true
    const ifmt = this.#type & IFMT
    // if we know it's not a dir or link, don't even try
    return !(ifmt === UNKNOWN || ifmt === IFDIR || ifmt === IFLNK)
  }

  /**
   * Return the Path object corresponding to the target of a symbolic link.
   *
   * If the Path is not a symbolic link, or if the readlink call fails for any
   * reason, `undefined` is returned.
   *
   * Result is cached, and thus may be outdated if the filesystem is mutated.
   */
  async readlink(): Promise<PathBase | undefined> {
    const target = this.#linkTarget
    if (target) {
      return target
    }
    if (this.#cannotReadlink()) {
      return undefined
    }
    /* c8 ignore start */
    // already covered by the cannotReadlink test, here for ts grumples
    if (!this.parent) {
      return undefined
    }
    /* c8 ignore stop */
    try {
      const read = await readlink(this.fullpath())
      const linkTarget = this.parent.resolve(read)
      if (linkTarget) {
        return (this.#linkTarget = linkTarget)
      }
    } catch (er) {
      this.#readlinkFail(er as NodeJS.ErrnoException)
      return undefined
    }
  }

  /**
   * Synchronous {@link PathBase.readlink}
   */
  readlinkSync(): PathBase | undefined {
    const target = this.#linkTarget
    if (target) {
      return target
    }
    if (this.#cannotReadlink()) {
      return undefined
    }
    /* c8 ignore start */
    // already covered by the cannotReadlink test, here for ts grumples
    if (!this.parent) {
      return undefined
    }
    /* c8 ignore stop */
    try {
      const read = readlinkSync(this.fullpath())
      const linkTarget = this.parent.resolve(read)
      if (linkTarget) {
        return (this.#linkTarget = linkTarget)
      }
    } catch (er) {
      this.#readlinkFail(er as NodeJS.ErrnoException)
      return undefined
    }
  }

  #cannotReadlink(): boolean {
    if (!this.parent) return false
    // cases where it cannot possibly succeed
    const ifmt = this.#type & IFMT
    return (
      !!(ifmt !== UNKNOWN && ifmt !== IFLNK) ||
      !!(this.#type & ENOREADLINK) ||
      !!(this.#type & ENOENT)
    )
  }

  #calledReaddir(): boolean {
    return (this.#type & READDIR_CALLED) === READDIR_CALLED
  }

  #readdirSuccess(children: Children) {
    // succeeded, mark readdir called bit
    this.#type |= READDIR_CALLED
    // mark all remaining provisional children as ENOENT
    for (let p = children.provisional; p < children.length; p++) {
      children[p].#markENOENT()
    }
  }

  #markENOENT() {
    // mark as UNKNOWN and ENOENT
    if (this.#type & ENOENT) return
    this.#type = (this.#type | ENOENT) & IFMT_UNKNOWN
    this.#markChildrenENOENT()
  }

  #markChildrenENOENT() {
    // all children are provisional and do not exist
    const children = this.children()
    children.provisional = 0
    for (const p of children) {
      p.#markENOENT()
    }
  }

  // save the information when we know the entry is not a dir
  #markENOTDIR() {
    // entry is not a directory, so any children can't exist.
    // if it's already marked ENOTDIR, bail
    if (this.#type & ENOTDIR) return
    let t = this.#type
    // this could happen if we stat a dir, then delete it,
    // then try to read it or one of its children.
    if ((t & IFMT) === IFDIR) t &= IFMT_UNKNOWN
    this.#type = t | ENOTDIR
    this.#markChildrenENOENT()
  }

  #readdirFail(er: NodeJS.ErrnoException) {
    if (er.code === 'ENOTDIR' || er.code === 'EPERM') {
      this.#markENOTDIR()
    }
    if (er.code === 'ENOENT') {
      this.#markENOENT()
    } else {
      this.children().provisional = 0
    }
  }

  #lstatFail(er: NodeJS.ErrnoException) {
    if (er.code === 'ENOTDIR') {
      const e = this.parent || this
      e.#markENOTDIR()
    } else if (er.code === 'ENOENT') {
      this.#markENOENT()
    }
  }

  #readlinkFail(er: NodeJS.ErrnoException) {
    let ter = this.#type
    ter |= ENOREADLINK
    if (er.code === 'ENOENT') ter |= ENOENT
    if (er.code === 'EINVAL') {
      // exists, but not a symlink, we don't know WHAT it is, so remove
      // all IFMT bits.
      ter &= IFMT_UNKNOWN
    }
    this.#type = ter
    if (er.code === 'ENOTDIR' && this.parent) {
      this.parent.#markENOTDIR()
    }
  }

  #readdirAddChild(e: Dirent, c: Children) {
    return (
      this.#readdirMaybePromoteChild(e, c) ||
      this.#readdirAddNewChild(e, c)
    )
  }

  #readdirAddNewChild(e: Dirent, c: Children): PathBase {
    // alloc new entry at head, so it's never provisional
    const type = entToType(e)
    const child = this.newChild(e.name, type, { parent: this })
    c.unshift(child)
    c.provisional++
    return child
  }

  #readdirMaybePromoteChild(e: Dirent, c: Children): PathBase | undefined {
    for (let p = c.provisional; p < c.length; p++) {
      const pchild = c[p]
      const name = this.nocase ? e.name.toLowerCase() : e.name
      if (name !== pchild.#matchName) {
        continue
      }

      return this.#readdirPromoteChild(e, pchild, p, c)
    }
  }

  #readdirPromoteChild(
    e: Dirent,
    p: PathBase,
    index: number,
    c: Children
  ): PathBase {
    const v = p.name
    p.#type = entToType(e)
    // case sensitivity fixing when we learn the true name.
    if (v !== e.name) p.name = e.name

    // just advance provisional index (potentially off the list),
    // otherwise we have to splice/pop it out and re-insert at head
    if (index !== c.provisional) {
      if (index === c.length - 1) c.pop()
      else c.splice(index, 1)
      c.unshift(p)
    }
    c.provisional++
    return p
  }

  /**
   * Call lstat() on this Path, and update all known information that can be
   * determined.
   *
   * Note that unlike `fs.lstat()`, the returned value does not contain some
   * information, such as `mode`, `dev`, `nlink`, and `ino`.  If that
   * information is required, you will need to call `fs.lstat` yourself.
   *
   * If the Path refers to a nonexistent file, or if the lstat call fails for
   * any reason, `undefined` is returned.  Otherwise the updated Path object is
   * returned.
   *
   * Results are cached, and thus may be out of date if the filesystem is
   * mutated.
   */
  async lstat(): Promise<PathBase | undefined> {
    if ((this.#type & ENOENT) === 0) {
      try {
        // retain any other flags, but set the ifmt
        this.#type =
          (this.#type & IFMT_UNKNOWN) |
          entToType(await lstat(this.fullpath()))
        return this
      } catch (er) {
        this.#lstatFail(er as NodeJS.ErrnoException)
      }
    }
  }

  /**
   * synchronous {@link PathBase.lstat}
   */
  lstatSync(): PathBase | undefined {
    if ((this.#type & ENOENT) === 0) {
      try {
        // retain any other flags, but set the ifmt
        this.#type =
          (this.#type & IFMT_UNKNOWN) |
          entToType(lstatSync(this.fullpath()))
        return this
      } catch (er) {
        this.#lstatFail(er as NodeJS.ErrnoException)
      }
    }
  }

  /**
   * Return an array of known child entries.
   *
   * If the Path cannot or does not contain any children, then an empty array
   * is returned.
   *
   * Results are cached, and thus may be out of date if the filesystem is
   * mutated.
   */
  async readdir(): Promise<PathBase[]> {
    if (this.#cannotReaddir()) {
      return []
    }

    const children = this.children()
    if (this.#calledReaddir()) {
      return children.slice(0, children.provisional)
    }

    // else read the directory, fill up children
    // de-provisionalize any provisional children.
    const fullpath = this.fullpath()
    try {
      for (const e of await readdir(fullpath, { withFileTypes: true })) {
        this.#readdirAddChild(e, children)
      }
      this.#readdirSuccess(children)
    } catch (er) {
      this.#readdirFail(er as NodeJS.ErrnoException)
      children.provisional = 0
    }
    return children.slice(0, children.provisional)
  }

  /**
   * synchronous {@link PathBase.readdir}
   */
  readdirSync(): PathBase[] {
    if (this.#cannotReaddir()) {
      return []
    }

    const children = this.children()
    if (this.#calledReaddir()) {
      return children.slice(0, children.provisional)
    }

    // else read the directory, fill up children
    // de-provisionalize any provisional children.
    const fullpath = this.fullpath()
    try {
      for (const e of readdirSync(fullpath, { withFileTypes: true })) {
        this.#readdirAddChild(e, children)
      }
      this.#readdirSuccess(children)
    } catch (er) {
      this.#readdirFail(er as NodeJS.ErrnoException)
      children.provisional = 0
    }
    return children.slice(0, children.provisional)
  }
}

/**
 * Path class used on win32 systems
 *
 * Uses `'\\'` as the path separator for returned paths, either `'\\'` or `'/'`
 * as the path separator for parsing paths.
 */
export class PathWin32 extends PathBase {
  /**
   * Separator for generating path strings.
   */
  sep: '\\' = '\\'
  /**
   * Separator for parsing path strings.
   */
  splitSep: RegExp = eitherSep

  /**
   * Do not create new Path objects directly.  They should always be accessed
   * via the PathWalker class or other methods on the Path class.
   *
   * @internal
   */
  constructor(
    name: string,
    type: number = UNKNOWN,
    root: PathBase | undefined,
    roots: { [k: string]: PathBase },
    nocase: boolean,
    children: ChildrenCache,
    opts: PathOpts
  ) {
    super(name, type, root, roots, nocase, children, opts)
  }

  /**
   * @internal
   */
  newChild(name: string, type: number = UNKNOWN, opts: PathOpts = {}) {
    return new PathWin32(
      name,
      type,
      this.root,
      this.roots,
      this.nocase,
      this.childrenCache(),
      opts
    )
  }

  /**
   * @internal
   */
  getRootString(path: string): string {
    return win32.parse(path).root
  }

  /**
   * @internal
   */
  getRoot(rootPath: string): PathBase {
    if (rootPath === this.root.name) {
      return this.root
    }
    if (this.sameRoot(rootPath)) {
      return (this.roots[rootPath] = this.root)
    }
    return (this.roots[rootPath] = new PathWalkerWin32(
      rootPath,
      this
    ).root)
  }

  /**
   * @internal
   */
  sameRoot(rootPath: string): boolean {
    rootPath = rootPath
      .replace(/\\/g, '\\')
      .replace(/\\\\\?\\([a-z]:)\\?$/, '$1:\\')
    // windows can (rarely) have case-sensitive filesystem, but
    // UNC and drive letters are always case-insensitive
    if (rootPath.toUpperCase() === this.root.name.toUpperCase()) {
      return true
    }
    return false
  }
}

/**
 * Path class used on all posix systems.
 *
 * Uses `'/'` as the path separator.
 */
export class PathPosix extends PathBase {
  /**
   * separator for parsing path strings
   */
  splitSep: '/' = '/'
  /**
   * separator for generating path strings
   */
  sep: '/' = '/'

  /**
   * Do not create new Path objects directly.  They should always be accessed
   * via the PathWalker class or other methods on the Path class.
   *
   * @internal
   */
  constructor(
    name: string,
    type: number = UNKNOWN,
    root: PathBase | undefined,
    roots: { [k: string]: PathBase },
    nocase: boolean,
    children: ChildrenCache,
    opts: PathOpts
  ) {
    super(name, type, root, roots, nocase, children, opts)
  }

  /**
   * @internal
   */
  getRootString(path: string): string {
    return path.startsWith('/') ? '/' : ''
  }

  /**
   * @internal
   */
  getRoot(_rootPath: string): PathBase {
    return this.root
  }

  /**
   * @internal
   */
  newChild(name: string, type: number = UNKNOWN, opts: PathOpts = {}) {
    return new PathPosix(
      name,
      type,
      this.root,
      this.roots,
      this.nocase,
      this.childrenCache(),
      opts
    )
  }
}

/**
 * Options that may be provided to the PathWalker constructor
 */
export interface PathWalkerOpts {
  /**
   * perform case-insensitive path matching. Default based on platform
   * subclass.
   */
  nocase?: boolean
  /**
   * Number of Path entries to keep in the cache of Path child references.
   *
   * Setting this higher than 65536 will dramatically increase the data
   * consumption and construction time overhead of each PathWalker.
   *
   * Setting this value to 256 or lower will significantly reduce the data
   * consumption and construction time overhead, but may also reduce resolve()
   * and readdir() performance on large filesystems.
   *
   * Default `16384`.
   */
  childrenCacheSize?: number
}

/**
 * The base class for all PathWalker classes, providing the interface for path
 * resolution and filesystem operations.
 *
 * Typically, you should *not* instantiate this class directly, but rather one
 * of the platform-specific classes, or the exported {@link PathWalker} which
 * defaults to the current platform.
 */
export abstract class PathWalkerBase {
  /**
   * The root Path entry for the current working directory of this walker
   */
  root: PathBase
  /**
   * The string path for the root of this walker's current working directory
   */
  rootPath: string
  /**
   * A collection of all roots encountered, referenced by rootPath
   */
  roots: { [k: string]: PathBase }
  /**
   * The Path entry corresponding to this PathWalker's current working directory.
   */
  cwd: PathBase
  /**
   * The string path of this PathWalker's current working directory
   */
  cwdPath: string
  #resolveCache: ResolveCache<string>
  #children: ChildrenCache
  /**
   * Perform path comparisons case-insensitively.
   *
   * Defaults true on Darwin and Windows systems, false elsewhere.
   */
  abstract nocase: boolean
  /**
   * The path separator used for parsing paths
   *
   * `'/'` on Posix systems, either `'/'` or `'\\'` on Windows
   */
  abstract sep: string | RegExp

  /**
   * This class should not be instantiated directly.
   *
   * Use PathWalkerWin32, PathWalkerDarwin, PathWalkerPosix, or PathWalker
   *
   * @internal
   */
  constructor(
    cwd: string = process.cwd(),
    pathImpl: typeof win32 | typeof posix,
    sep: string | RegExp,
    { childrenCacheSize = 16 * 1024 }: PathWalkerOpts = {}
  ) {
    // resolve and split root, and then add to the store.
    // this is the only time we call path.resolve()
    const cwdPath = pathImpl.resolve(cwd)
    this.roots = Object.create(null)
    this.cwdPath = cwdPath
    this.rootPath = this.parseRootPath(cwdPath)
    this.#resolveCache = new ResolveCache()
    this.#children = new ChildrenCache(childrenCacheSize)

    const split = cwdPath.substring(this.rootPath.length).split(sep)
    // resolve('/') leaves '', splits to [''], we don't want that.
    if (split.length === 1 && !split[0]) {
      split.pop()
    }
    // we can safely assume the root is a directory.
    const existing = this.roots[this.rootPath]
    if (existing) {
      this.root = existing
    } else {
      this.root = this.newRoot()
      this.roots[this.rootPath] = this.root
    }
    let prev: PathBase = this.root
    for (const part of split) {
      prev = prev.child(part)
    }
    this.cwd = prev
  }

  /**
   * Parse the root portion of a path string
   *
   * @internal
   */
  abstract parseRootPath(dir: string): string
  /**
   * create a new Path to use as root during construction.
   *
   * @internal
   */
  abstract newRoot(): PathBase
  /**
   * Determine whether a given path string is absolute
   */
  abstract isAbsolute(p: string): boolean

  /**
   * Return the cache of child entries.  Exposed so subclasses can create
   * child Path objects in a platform-specific way.
   *
   * @internal
   */
  childrenCache() {
    return this.#children
  }

  /**
   * Resolve one or more path strings to a resolved string
   *
   * Same interface as require('path').resolve.
   *
   * Much faster than path.resolve() when called multiple times for the same
   * path, because the resolved Path objects are cached.  Much slower
   * otherwise.
   */
  resolve(...paths: string[]): string {
    // first figure out the minimum number of paths we have to test
    // we always start at cwd, but any absolutes will bump the start
    let r = ''
    for (let i = paths.length - 1; i >= 0; i--) {
      const p = paths[i]
      if (!p || p === '.') continue
      r = r ? `${p}/${r}` : p
      if (this.isAbsolute(p)) {
        break
      }
    }
    const cached = this.#resolveCache.get(r)
    if (cached !== undefined) {
      return cached
    }
    const result = this.cwd.resolve(r).fullpath()
    this.#resolveCache.set(r, result)
    return result
  }

  /**
   * Return the basename for the provided string or Path object
   */
  basename(entry: PathBase | string = this.cwd): string {
    if (typeof entry === 'string') {
      entry = this.cwd.resolve(entry)
    }
    return entry.name
  }

  /**
   * Return the dirname for the provided string or Path object
   */
  dirname(entry: PathBase | string = this.cwd): string {
    if (typeof entry === 'string') {
      entry = this.cwd.resolve(entry)
    }
    return (entry.parent || entry).fullpath()
  }

  /**
   * Return an array of known child entries.
   *
   * First argument may be either a string, or a Path object.
   *
   * If the Path cannot or does not contain any children, then an empty array
   * is returned.
   *
   * Results are cached, and thus may be out of date if the filesystem is
   * mutated.
   *
   * Unlike `fs.readdir()`, the `withFileTypes` option defaults to `true`. Set
   * `{ withFileTypes: false }` to return strings.
   */
  readdir(
    entry?: PathBase | string,
    options?: { withFileTypes: true }
  ): Promise<PathBase[]>
  readdir(
    entry: PathBase | string,
    options: { withFileTypes: false }
  ): Promise<string[]>
  readdir(
    entry: PathBase | string,
    options: { withFileTypes: boolean }
  ): Promise<string[] | PathBase[]>
  async readdir(
    entry: PathBase | string = this.cwd,
    { withFileTypes = true }: { withFileTypes: boolean } = {
      withFileTypes: true,
    }
  ): Promise<PathBase[] | string[]> {
    if (typeof entry === 'string') {
      entry = this.cwd.resolve(entry)
    }
    if (withFileTypes) {
      return entry.readdir()
    } else {
      return (await entry.readdir()).map(e => e.name)
    }
  }

  /**
   * synchronous {@link PathWalkerBase.readdir}
   */
  readdirSync(
    entry?: PathBase | string,
    options?: { withFileTypes: true }
  ): PathBase[]
  readdirSync(
    entry: PathBase | string,
    options: { withFileTypes: false }
  ): string[]
  readdirSync(
    entry: PathBase | string,
    options: { withFileTypes: boolean }
  ): string[] | PathBase[]
  readdirSync(
    entry: PathBase | string = this.cwd,
    { withFileTypes = true }: { withFileTypes: boolean } = {
      withFileTypes: true,
    }
  ): PathBase[] | string[] {
    if (typeof entry === 'string') {
      entry = this.cwd.resolve(entry)
    }
    if (withFileTypes) {
      return entry.readdirSync()
    } else {
      return entry.readdirSync().map(e => e.name)
    }
  }

  /**
   * Call lstat() on the string or Path object, and update all known
   * information that can be determined.
   *
   * Note that unlike `fs.lstat()`, the returned value does not contain some
   * information, such as `mode`, `dev`, `nlink`, and `ino`.  If that
   * information is required, you will need to call `fs.lstat` yourself.
   *
   * If the Path refers to a nonexistent file, or if the lstat call fails for
   * any reason, `undefined` is returned.  Otherwise the updated Path object is
   * returned.
   *
   * Results are cached, and thus may be out of date if the filesystem is
   * mutated.
   */
  async lstat(
    entry: string | PathBase = this.cwd
  ): Promise<PathBase | undefined> {
    if (typeof entry === 'string') {
      entry = this.cwd.resolve(entry)
    }
    return entry.lstat()
  }

  /**
   * synchronous {@link PathWalkerBase.lstat}
   */
  lstatSync(entry: string | PathBase = this.cwd): PathBase | undefined {
    if (typeof entry === 'string') {
      entry = this.cwd.resolve(entry)
    }
    return entry.lstatSync()
  }

  /**
   * Return the Path object or string path corresponding to the target of a
   * symbolic link.
   *
   * If the path is not a symbolic link, or if the readlink call fails for any
   * reason, `undefined` is returned.
   *
   * Result is cached, and thus may be outdated if the filesystem is mutated.
   *
   * `{withFileTypes}` option defaults to `false`.
   *
   * On success, returns a Path object if `withFileTypes` option is true,
   * otherwise a string.
   */
  readlink(
    entry: string | PathBase,
    opt?: { withFileTypes: false }
  ): Promise<string | undefined>
  readlink(
    entry: string | PathBase,
    opt: { withFileTypes: true }
  ): Promise<PathBase | undefined>
  readlink(
    entry: string | PathBase,
    opt: { withFileTypes: boolean }
  ): Promise<string | PathBase | undefined>
  async readlink(
    entry: string | PathBase,
    { withFileTypes }: { withFileTypes: boolean } = {
      withFileTypes: false,
    }
  ): Promise<string | PathBase | undefined> {
    if (typeof entry === 'string') {
      entry = this.cwd.resolve(entry)
    }
    const e = await entry.readlink()
    return withFileTypes ? e : e?.fullpath()
  }

  /**
   * synchronous {@link PathWalkerBase.readlink}
   */
  readlinkSync(
    entry: string | PathBase,
    opt?: { withFileTypes: false }
  ): string | undefined
  readlinkSync(
    entry: string | PathBase,
    opt: { withFileTypes: true }
  ): PathBase | undefined
  readlinkSync(
    entry: string | PathBase,
    opt: { withFileTypes: boolean }
  ): string | PathBase | undefined
  readlinkSync(
    entry: string | PathBase,
    { withFileTypes }: { withFileTypes: boolean } = {
      withFileTypes: false,
    }
  ): string | PathBase | undefined {
    if (typeof entry === 'string') {
      entry = this.cwd.resolve(entry)
    }
    const e = entry.readlinkSync()
    return withFileTypes ? e : e?.fullpath()
  }
}

/**
 * Windows implementation of {@link PathWalkerBase}
 *
 * Defaults to case insensitve, uses `'\\'` to generate path strings.  Uses
 * {@link PathWin32} for Path objects.
 */
export class PathWalkerWin32 extends PathWalkerBase {
  /**
   * Default case insensitive
   */
  nocase: boolean = true
  /**
   * separator for generating path strings
   */
  sep: '\\' = '\\'

  constructor(cwd: string = process.cwd(), opts: PathWalkerOpts = {}) {
    super(cwd, win32, '\\', opts)
    const { nocase = this.nocase } = opts
    this.nocase = nocase
  }

  /**
   * @internal
   */
  parseRootPath(dir: string): string {
    // if the path starts with a single separator, it's not a UNC, and we'll
    // just get separator as the root, and driveFromUNC will return \
    // In that case, mount \ on the root from the cwd.
    const rootPath = win32.parse(dir).root
    const driveFromUNC = uncToDrive(rootPath)
    if (driveFromUNC === this.sep) {
      return driveCwd(win32.resolve(driveFromUNC)) + this.sep
    } else {
      return driveFromUNC
    }
  }


  /**
   * @internal
   */
  newRoot() {
    return new PathWin32(
      this.rootPath,
      IFDIR,
      undefined,
      this.roots,
      this.nocase,
      this.childrenCache(),
      {}
    )
  }

  /**
   * Return true if the provided path string is an absolute path
   */
  isAbsolute(p: string): boolean {
    return (
      p.startsWith('/') || p.startsWith('\\') || /^[a-z]:(\/|\\)/i.test(p)
    )
  }
}

/**
 * {@link PathWalkerBase} implementation for all posix systems other than Darwin.
 *
 * Defaults to case-sensitive matching, uses `'/'` to generate path strings.
 *
 * Uses {@link PathPosix} for Path objects.
 */
export class PathWalkerPosix extends PathWalkerBase {
  /**
   * Default case sensitive
   */
  nocase: boolean = false
  /**
   * separator for generating path strings
   */
  sep: '/' = '/'
  constructor(cwd: string = process.cwd(), opts: PathWalkerOpts = {}) {
    super(cwd, posix, '/', opts)
    const { nocase = this.nocase } = opts
    this.nocase = nocase
  }

  /**
   * @internal
   */
  parseRootPath(_dir: string): string {
    return '/'
  }

  /**
   * @internal
   */
  newRoot() {
    return new PathPosix(
      this.rootPath,
      IFDIR,
      undefined,
      this.roots,
      this.nocase,
      this.childrenCache(),
      {}
    )
  }

  /**
   * Return true if the provided path string is an absolute path
   */
  isAbsolute(p: string): boolean {
    return p.startsWith('/')
  }
}

/**
 * {@link PathWalkerBase} implementation for Darwin (macOS) systems.
 *
 * Defaults to case-insensitive matching, uses `'/'` for generating path
 * strings.
 *
 * Uses {@link PathPosix} for Path objects.
 */
export class PathWalkerDarwin extends PathWalkerPosix {
  /**
   * default case-insensitive
   */
  nocase: boolean = true
}

/**
 * Default {@link PathBase} implementation for the current platform.
 *
 * {@link PathWin32} on Windows systems, {@link PathPosix} on all others.
 */
export const Path: typeof PathBase =
  process.platform === 'win32' ? PathWin32 : PathPosix
export type Path = PathBase

/**
 * Default {@link PathWalkerBase} implementation for the current platform.
 *
 * {@link PathWalkerWin32} on Windows systems, {@link PathWalkerDarwin} on
 * Darwin (macOS) systems, {@link PathWalkerPosix} on all others.
 */
export const PathWalker:
  | typeof PathWalkerWin32
  | typeof PathWalkerDarwin
  | typeof PathWalkerPosix =
  process.platform === 'win32'
    ? PathWalkerWin32
    : process.platform === 'darwin'
    ? PathWalkerDarwin
    : PathWalkerPosix
export type PathWalker = PathWalkerBase

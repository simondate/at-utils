import { createInterface } from 'readline'
import { exec } from 'child_process'
import { pathToFileURL } from 'url'
import fetch from 'node-fetch'
import fs from 'fs/promises'
import path from 'path'
import prompts from 'prompts'
import semver from 'semver'

const GITHUB_ORG_URL = 'https://github.com/adapt-security'
const GITHUB_REPO = 'adapt-authoring'

let app

export default class Utils {
  static get cliRoot () {
    return path.resolve(process.argv[1], '../../at-utils')
  }

  static async loadPackage (filePath) {
    return this.loadJson(path.join(filePath, 'package.json'))
  }

  static async importCore (root) {
    return import(pathToFileURL(path.join(root, 'node_modules', 'adapt-authoring-core', 'index.js')))
  }

  static async checkPrerequisites (options = {}) {
    const { prerequisites: prereqs } = await this.loadPackage(this.cliRoot)
    const failedPrereqs = (await Promise.allSettled(Object.entries(prereqs).map(async ([name, version]) => {
      let data
      try {
        data = await this.exec(`${name} --version`)
      } catch (e) {
        throw new Error(`Missing prerequisite '${name}'`)
      }
      const match = data.match(/(\d+\.\d+\.\d+)\D/)
      const installedVersion = match && match[1]
      if (!semver.satisfies(installedVersion, version)) {
        throw new Error(`Installed version of ${name} (${installedVersion}) doesn't satisfy required version (${version})`)
      }
    }))).filter(p => p.status === 'rejected').map(p => p.reason)
    if (failedPrereqs.length) {
      const msg = failedPrereqs.reduce((m, e2) => `${m}- ${e2.message}\n`, 'Prerequisite check failed:\n')
      if (options.ignorePrereqs) {
        console.log(msg)
        console.log('WARNING: --ignore-prereqs flag passed so process will continue')
        console.log('WARNING: If issues are encountered please make sure the correct prerequisites are installed\n')
        return
      }
      throw new Error(msg)
    }
  }

  static async githubRequest (endpoint, opts = {}) {
    const { GITHUB_USER, GITHUB_TOKEN } = process.env

    if (GITHUB_USER && GITHUB_TOKEN) {
      const authHash = Buffer.from(`${GITHUB_USER}:${GITHUB_TOKEN}`).toString('base64')
      opts.headers = { Authorization: `Basic ${authHash}` }
    }
    const response = await fetch(`https://api.github.com/repos/adapt-security/adapt-authoring/${endpoint}`, opts)
    if (response.status > 299) {
      throw new Error(response.statusText)
    }
    if (response.status !== 204) return response.json()
  }

  static async getReleases (options) {
    let currentVersionDate
    try {
      currentVersionDate = new Date(await this.exec('git log -1 --format=%cd', options.cwd))
    } catch (e) {}
    const releases = (await this.githubRequest('releases?per_page=10'))

    if (options.includeBranches) {
      await Promise.all((await this.githubRequest('branches')).map(async b => {
        const { commit } = await this.githubRequest(b.commit.url.slice(b.commit.url.indexOf('commits/')))
        releases.push({
          name: `${b.name} (branch)`,
          tag_name: b.name,
          published_at: commit.author.date,
          branch: true
        })
      }))
    }
    return releases
      .map(r => {
        return Object.assign(r, {
          name: `${r.name}${r.draft ? ' (draft)' : r.prerelease ? ' (prerelease)' : ''}`,
          date: new Date(r.published_at)
        })
      })
      .filter(r => {
        if ((r.tag_name === options.currentVersion) || (r.prerelease && !options.includePrereleases) || (r.draft && !options.includeDrafts)) {
          return false
        }
        const noCurrent = !options.currentVersion
        const semverNewer = (semver.valid(options.currentVersion) && semver.valid(r.tag_name) && semver.gt(r.tag_name, options.currentVersion)) ?? false
        const gitNewer = r.date > currentVersionDate
        return noCurrent || semverNewer || gitNewer
      })
      .sort((a, b) => a.date < b.date ? 1 : -1)
  }

  static async exec (command, cwd = process.cwd()) {
    return new Promise((resolve, reject) => {
      exec(command, { cwd }, (error, stdout, stderr) => error ? reject(new Error(error || stderr) || error) : resolve(stdout))
    })
  }

  static async startApp (cwd = process.cwd()) {
    if (!app) {
      const { App } = await Utils.importCore(cwd)
      try {
        process.env.ADAPT_AUTHORING_LOGGER__mute = true
        await App.instance.onReady()
        app = App.instance
      } catch (e) {
        return console.log(e)
      }
    }
    return app
  }

  static async cloneRepo (options) {
    const url = `${GITHUB_ORG_URL}/${options.repo || GITHUB_REPO}.git`
    const tag = options.tag || 'master'
    console.log(`Cloning ${url}#${tag} into ${options.cwd}`)
    try {
      await this.exec(`git clone --branch ${tag} ${url} ${options.cwd}`)
    } catch (e) {
      const error = new Error(`Failed to clone git repository, ${e.message}`)
      error.code = 'GITCLONEEEXIST'
      throw error
    }
    console.log('Installing npm dependencies')
    await this.exec(`npm ${options.cleanInstall === false ? 'install' : 'ci'}`, options.cwd)
  }

  static async updateRepo (options) {
    console.log(`Checking out ${options.tag} in ${options.cwd}`)
    await this.exec('git fetch --all --tags', options.cwd)
    await this.exec('git reset --hard', options.cwd)
    await this.exec(`git checkout ${options.tag}`, options.cwd)
    await fs.rm(`${options.cwd}/node_modules`, { recursive: true })
    console.log('Installing npm dependencies')
    await this.exec('npm ci', options.cwd)
  }

  static async getSchemas (rootDir) {
    const schemas = { config: {}, user: {} }
    const configSchemaPaths = await getConfigSchemaPathsRecursive(path.resolve(rootDir, 'node_modules'))
    await Promise.all(configSchemaPaths.map(async s => {
      const { name, version, description } = await this.loadPackage(path.resolve(path.dirname(s), '..'))
      const schema = await this.loadJson(s)
      schemas.config[name] = { name, description, version, schema }
    }))
    schemas.user = {
      properties: {
        superUser: {
          title: 'superuser',
          type: 'object',
          properties: {
            email: { description: 'Email address for the user', type: 'string', format: 'email' },
            password: { description: 'Password for the user', type: 'string', format: 'password' },
            confirmPassword: { description: 'Re-enter password', type: 'string', format: 'password' }
          },
          required: ['email', 'password', 'confirmPassword']
        }
      }
    }
    return schemas
  }

  static async loadJson (filePath) {
    try {
      return JSON.parse(await fs.readFile(filePath))
    } catch (e) {
      throw new Error(`Failed to load ${filePath}`)
    }
  }

  static async saveConfig (rootDir, data) {
    const configDir = path.resolve(rootDir, 'conf')
    const configPath = path.resolve(configDir, `${process.env.NODE_ENV}.config.js`)
    const config = { ...data }
    console.log('Simons testing')
    console.log(rootDir)
    console.log(data)
    try {
      await fs.mkdir(configDir, { recursive: true })
    } catch (e) {} // not a problem
    await fs.writeFile(configPath, `export default ${JSON.stringify(config, null, 2)};`)
  }

  static async registerSuperUser (options = {}) {
    try {
      await this.internalApiRequest('', undefined, { ...options, method: 'GET' })
    } catch (e) {
      if (e.code !== 'ECONNREFUSED') throw e
      await this.startApp(options.cwd)
    }
    let email = options.superEmail
    let password = options.pipePasswd ? await this.getPipedPassword() : options.superPassword
    let success = false
    while (!success) {
      try {
        if (!email) {
          const { emailInput } = await await prompts([{
            type: 'text',
            name: 'emailInput',
            message: 'Enter an email address to be used as a login for the Super User account'
          }])
          email = emailInput
        }
        if (!password) {
          const { passwordInput1, passwordInput2 } = await prompts([{
            type: 'password',
            name: 'passwordInput1',
            message: 'Enter a password for the Super User account'
          }, {
            type: 'password',
            name: 'passwordInput2',
            message: 'Please type the password again to confirm'
          }])
          if (passwordInput1 !== passwordInput2) {
            console.log('Passwords don\'t match. Please try again')
            continue
          }
          password = passwordInput1
        }
        await this.internalApiRequest('auth/local/registersuper', { email, password }, options)
        success = true
      } catch (e) {
        if (e.code !== 'VALIDATION_FAILED') throw e // only loop if it's a validation error
        console.log(`\nERROR: Failed to register super user, ${e.data.errors}\n`)
      }
    }
  }

  static getPipedPassword () {
    return new Promise(resolve => {
      createInterface({ input: process.stdin, output: process.stdout, terminal: false })
        .on('line', s => resolve(s))
    })
  }

  static parseQuery (req) {
    const [url, query] = req.url.split('?')
    if (!query) {
      return {}
    }
    req.url = url
    return query.split('&').reduce((q, s) => {
      const [k, v] = s.split('=')
      return { ...q, [k]: v }
    }, {})
  }

  static async parseBody (req) {
    if (req.method !== 'POST') {
      return {}
    }
    return new Promise((resolve, reject) => {
      const body = ''
      req.on('data', data => body.concat(data))
      req.on('error', e => reject(e))
      req.on('end', () => resolve(body.length > 0 ? JSON.parse(body) : undefined))
    })
  }

  static async getAppDependencies (cwd) {
    const deps = { adapt: {}, all: {}, dev: {} }
    const adaptDeps = await getAdaptDepsRecursive(path.join(cwd, 'node_modules'))
    await Promise.all(adaptDeps.map(async d => {
      const { name, version, dependencies, devDependencies } = await JSON.parse(await fs.readFile(path.join(d, 'package.json')))
      deps.adapt[name] = version
      ;[[dependencies, deps.all], [devDependencies, deps.dev]].forEach(([deps = {}, memo]) => {
        Object.entries(deps).forEach(([k, v]) => {
          if (!memo[k]) memo[k] = []
          if (!memo[k].includes(v)) memo[k].push(v)
          memo[k] = memo[k].sort()
        })
      })
    }))
    processDeps(deps)
    const adaptKeys = Object.keys(deps.adapt)
    Object.keys(deps.all).forEach(k => {
      if (adaptKeys.includes(k)) delete deps.all[k]
    })
    return deps
  }

  static async installLocalModules (options) {
    const dir = path.join(options.cwd, 'local_adapt_modules')
    await Promise.all(options.modules.map(m => this.cloneRepo({ repo: m, cwd: path.join(dir, m), cleanInstall: false })))
    return this.exec('npm install', options.cwd) // need to run another npm install to pull in the local repos
  }

  static getStartCommands (cwd) {
    const getCmd = dir => `cd ${dir}\nnpm start`
    const data = { bash: getCmd(cwd) }
    if (process.platform === 'win32') {
      data.windows = getCmd(cwd)
      const driveLetter = cwd.match(/^[A-Z]/)[0].toLowerCase()
      data.bash = getCmd(`/${driveLetter}/${cwd.replaceAll(/\\/g, '/').slice(3)}`)
    }
    return data
  }

  static async internalApiRequest (endpoint, data, opts = {}) {
    const options = {
      method: opts.method ?? 'POST',
      headers: opts.headers ?? { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined
    }
    const config = (await import(pathToFileURL(path.join(opts.cwd ?? process.cwd(), 'conf', `${process.env.NODE_ENV}.config.js`)))).default
    const { host, port } = config['adapt-authoring-server']
    const response = await fetch(`http://${host}:${port}/api/${endpoint}`, options)
    if (response.status === 204) {
      return
    }
    if (response.status > 299) {
      const responseData = await response.json()
      const e = new Error(responseData.message)
      e.code = responseData.code
      e.statusCode = response.status
      throw e
    }
  }
}

async function getConfigSchemaPathsRecursive (dir, files = []) {
  const relativeSchemaPath = path.join('conf', 'config.schema.json')
  const contents = await fs.readdir(dir)
  await Promise.all(contents.map(async c => {
    const fullPath = path.resolve(dir, c)
    if ((await fs.stat(fullPath)).isDirectory()) return getConfigSchemaPathsRecursive(fullPath, files)
    if (fullPath.endsWith(relativeSchemaPath)) files.push(fullPath)
  }))
  return files
};

async function getAdaptDepsRecursive (dir, dirs = []) {
  const metaFilename = 'adapt-authoring.json'
  const contents = await fs.readdir(dir)
  await Promise.all(contents.map(async c => {
    const fullPath = path.resolve(dir, c)
    if ((await fs.stat(fullPath)).isDirectory()) return getAdaptDepsRecursive(fullPath, dirs)
    if (fullPath.endsWith(metaFilename)) dirs.push(path.dirname(fullPath))
  }))
  return dirs
};

function processDeps (deps) {
  Object.entries(deps).forEach(([k, v]) => {
    const sorted = {}
    Object.keys(v).sort().forEach(d => {
      let versions = v[d]
      if (v[d].length === 1) versions = v[d][0]
      sorted[d] = versions
    })
    deps[k] = sorted
  })
}

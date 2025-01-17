import { config } from 'joplin-api'
import { loadConfig } from '../options/utils/loadConfig'
import { google } from './plugins/google'
import { SearchPlugin } from './plugins/plugin'
import { bing } from './plugins/bing'
import { baidu } from './plugins/baidu'
import { duckduckgo } from './plugins/duckduckgo'
import browser from 'webextension-polyfill'
import { searx } from './plugins/searx'
import { metagar } from './plugins/metagar'
import { you } from './plugins/you'
import { search } from './utils/search'

const plugins: SearchPlugin[] = [google(), bing(), baidu(), duckduckgo(), searx(), metagar(), you()]

function findPlugin() {
  const u = new URL(location.href)
  return plugins.find((item) => item.match(u))
}

async function main() {
  console.debug('load plugin')
  const plugin = findPlugin()
  if (!plugin) {
    console.info('找不到合适的插件')
    return
  }
  console.debug('load config')
  const c = await loadConfig()
  if (!c.token) {
    alert('Joplin Search Integration: Please configure the token first')
    browser.runtime.sendMessage({
      action: 'open',
      path: '/',
    })
    return
  }
  config.token = c.token
  config.baseUrl = c.baseUrl
  console.debug('get query')
  const keywrod = plugin.getQuery()
  if (!keywrod) {
    throw new Error('未能解析搜索关键字')
  }
  console.debug('search notes')
  // const list = await search(keywrod)
  const list = await browser.runtime.sendMessage({
    action: 'search',
    keywrod,
  })
  console.debug('search: ', keywrod, list)
  console.debug('render start')
  plugin.render(list)
  console.debug('render end')
}

main()

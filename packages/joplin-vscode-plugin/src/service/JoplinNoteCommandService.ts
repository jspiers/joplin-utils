import { JoplinTreeItem, JoplinListNote } from '../provider/JoplinTreeItem'
import * as vscode from 'vscode'
import { QuickPickItem, TreeView } from 'vscode'
import { folderApi, folderExtApi, noteApi, noteExtApi, PageUtil, resourceApi, searchApi, TypeEnum } from 'joplin-api'
import { NoteExplorerProvider } from '../provider/NoteExplorerProvider'
import { FolderOrNoteExtendsApi } from '../api/FolderOrNoteExtendsApi'
import { JoplinNoteUtil } from '../util/JoplinNoteUtil'
import * as path from 'path'
import { close, mkdirp, pathExists, readFile, remove, writeFile } from '@liuli-util/fs-extra'
import { createEmptyFile } from '../util/createEmptyFile'
import { UploadResourceUtil } from '../util/UploadResourceUtil'
import { uploadResourceService } from './UploadResourceService'
import { HandlerService } from './HandlerService'
import { t } from '../constants/i18n'
import { GlobalContext } from '../constants/context'
import { watch } from 'chokidar'
import { AsyncArray } from '@liuli-util/async'
import { filenamify } from '../util/filenamify'
import { NoteProperties } from 'joplin-api'
import { logger } from '../constants/logger'
import { fileSuffix } from '../util/fileSuffix'
import { joplinNoteApi } from '../api/JoplinNoteApi'
import { extConfig } from '../constants/config'
import { debounce } from 'lodash-es'

export class JoplinNoteCommandService {
  private folderOrNoteExtendsApi = new FolderOrNoteExtendsApi()
  public handlerService!: HandlerService

  constructor(
    private config: {
      noteViewProvider: NoteExplorerProvider
      noteListTreeView: TreeView<JoplinTreeItem>
    },
  ) {}

  async init() {
    setInterval(async () => {
      await this.config.noteViewProvider.refresh()
    }, 1000 * 10)
    const tempNoteDirPath = path.resolve(GlobalContext.context.globalStorageUri.fsPath, '.tempNote')
    const tempResourceDirPath = path.resolve(GlobalContext.context.globalStorageUri.fsPath, '.tempResource')
    await AsyncArray.forEach([tempNoteDirPath, tempResourceDirPath], async (path) => {
      // await remove(path)
      await mkdirp(path)
    })
    watch(tempNoteDirPath)
      .on('change', async (filePath) => {
        const id = GlobalContext.openNoteMap.get(filePath)
        if (!id) {
          return
        }
        const content = await readFile(filePath, 'utf-8')
        const { title, body } = JoplinNoteUtil.splitTitleBody(content)
        const newNote = { id, body } as NoteProperties
        if (title) {
          newNote.title = title.startsWith('# ') ? title.substring(2) : title
        }
        await noteApi.update(newNote)
        this.config.noteViewProvider.fire()
        GlobalContext.noteSearchProvider.refresh(newNote)
        const resourceList = await noteApi.resourcesById(id)
        GlobalContext.openNoteResourceMap.set(id, resourceList)
      })
      .on('error', (err) => {
        logger.error('watch note error: ' + err)
      })
    watch(tempResourceDirPath)
      .on('change', async (filePath) => {
        const id = GlobalContext.openResourceMap.get(filePath)
        if (!id) {
          return
        }
        try {
          const data = await readFile(filePath)
          const r = await resourceApi.update({
            id,
            // @ts-expect-error
            data: new Blob([data]),
            filename: path.basename(filePath),
          })
          console.log('resource update? ', r)
        } catch (err) {
          logger.error('update resource error: ' + err)
        }
      })
      .on('error', (err) => {
        logger.error('watch resource error: ' + err)
      })
  }

  /**
   * create folder or note
   * @param type
   * @param item
   */
  async create(type: 'folder' | 'note' | 'todo', item: JoplinTreeItem = this.config.noteListTreeView.selection[0]) {
    const parentFolderId = !item ? '' : item.item.type_ === TypeEnum.Folder ? item.item.id : item.item.parent_id
    console.log('joplin.create: ', item, parentFolderId)

    const title = await vscode.window.showInputBox({
      placeHolder: t('Please enter what you want to create {{type}} name', {
        type: t(type === 'folder' ? 'folder' : type === 'note' ? 'note' : 'todo'),
      }),
    })
    if (!title) {
      return
    }

    if (type === 'folder') {
      await folderApi.create({
        title,
        parent_id: parentFolderId,
      })
      await this.config.noteViewProvider.refresh()
      return
    }
    const { id } = await noteApi.create({
      title,
      parent_id: parentFolderId,
      is_todo: type === 'todo' ? 1 : 0,
    })
    await this.config.noteViewProvider.refresh()
    await GlobalContext.handlerService.openNote(id)
  }

  /**
   * remove folder or note
   * @param item
   */
  async remove(item: JoplinTreeItem = this.config.noteListTreeView.selection[0]) {
    console.log('joplin.remove: ', item)
    const folderOrNote = item.item
    if (extConfig.deleteConfirm) {
      const confirmMsg = t('confirm')
      const cancelMsg = t('cancel')
      const res = await vscode.window.showQuickPick([confirmMsg, cancelMsg], {
        placeHolder: t('delete or not {{type}} [{{title}}]', {
          type: t(
            folderOrNote.type_ === TypeEnum.Folder
              ? 'folder'
              : (folderOrNote as JoplinListNote).is_todo
              ? 'todo'
              : 'note',
          ),
          title: folderOrNote.title,
        }),
      })
      console.log(res)
      if (res !== confirmMsg) {
        return
      }
    }

    if (GlobalContext.openNoteMap.get(item.id)) {
      await remove(GlobalContext.openNoteMap.get(item.id)!)
      GlobalContext.openNoteMap.delete(item.id)
      GlobalContext.openNoteResourceMap.delete(item.id)
      // TODO 目前无法关闭指定的 TextDocument，参考：https://github.com/Microsoft/vscode/commit/d625b55e9ec33f95d2fe1dd7a4b7cb50abb4772c#diff-4654cd1aa2a333bc6cc7ca0d19fdfb6e
    }
    await this.folderOrNoteExtendsApi.remove(item.item)
    await this.config.noteViewProvider.refresh()
  }

  async rename(item: JoplinTreeItem = this.config.noteListTreeView.selection[0]) {
    console.log('joplin.rename: ', item)
    const title = await vscode.window.showInputBox({
      placeHolder: t('Please enter a new name'),
      value: item.item.title,
    })
    if (!title) {
      return
    }
    await this.folderOrNoteExtendsApi.rename({
      id: item.item.id,
      title,
      type_: item.item.type_,
    })
    await this.config.noteViewProvider.refresh()
  }

  async copyLink(item: JoplinTreeItem = this.config.noteListTreeView.selection[0]) {
    console.log('joplin.copyLink: ', item)
    const label = JoplinNoteUtil.trimTitleStart(item.label!.trim())
    const url = `[${label}](:/${item.id})`
    vscode.env.clipboard.writeText(url)
  }

  async toggleTodoState(item: JoplinTreeItem = this.config.noteListTreeView.selection[0]) {
    await noteExtApi.toggleTodo(item.id)
    await this.config.noteViewProvider.refresh()
  }

  /**
   * open note in vscode
   * @param item
   */
  async openNote(
    item: JoplinListNote,
    position?: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    },
  ) {
    function real(
      editor: vscode.TextEditor,
      position: {
        start: { line: number; character: number }
        end: { line: number; character: number }
      },
    ) {
      const startPosition = new vscode.Position(position.start.line, position.start.character)
      const endPosition = new vscode.Position(position.end.line, position.end.character)
      const newSelection = new vscode.Selection(startPosition, endPosition)
      // 设置选区
      editor.selection = newSelection
      editor.revealRange(newSelection)
      const decorationRange = new vscode.Range(startPosition, endPosition)
      const highlightDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255,255,0,0.5)', // 黄色半透明背景
      })
      editor.setDecorations(highlightDecoration, [decorationRange])
      setTimeout(() => {
        editor.setDecorations(highlightDecoration, [])
      }, 200)
    }
    logger.info(`openNote start, id: ${item.id}, title: ${item.title}`)
    // 如果已经打开了笔记，则应该切换并且保持 treeview 的焦点
    if (GlobalContext.openNoteMap.has(item.id)) {
      const filePath = GlobalContext.openNoteMap.get(item.id)!
      if (vscode.window.activeTextEditor?.document.fileName !== filePath) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath))
      }
      if (position) {
        real(vscode.window.activeTextEditor!, position)
      }
      await this.focus(item.id)
      return
    }
    const tempNoteDirPath = path.resolve(GlobalContext.context.globalStorageUri.fsPath, '.tempNote')
    let tempNotePath = path.resolve(tempNoteDirPath, filenamify(`${item.title}.md`))
    if (GlobalContext.openNoteMap.has(tempNotePath)) {
      tempNotePath = fileSuffix(tempNotePath, item.id)
    }
    const note = await noteApi.get(item.id, ['body', 'title'])
    const content = JoplinNoteUtil.getNoteContent(note)
    await writeFile(tempNotePath, content)
    logger.info('openNote write tempFile: ' + path.basename(tempNotePath))
    GlobalContext.openNoteMap.set(item.id, tempNotePath)
    GlobalContext.openNoteResourceMap.set(item.id, await noteApi.resourcesById(item.id))
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(tempNotePath))
    if (position && vscode.window.activeTextEditor) {
      real(vscode.window.activeTextEditor, position)
    }
    logger.info('openNote open tempFile')
  }

  /**
   * show search input box
   */
  async search(item?: JoplinTreeItem) {
    interface SearchNoteItem extends QuickPickItem {
      id: string
    }
    const searchQuickPickBox = vscode.window.createQuickPick<SearchNoteItem>()
    searchQuickPickBox.value = item ? `notebook:"${item.item.title}" ` : ''
    searchQuickPickBox.placeholder = t('Please enter key words')
    searchQuickPickBox.canSelectMany = false
    searchQuickPickBox.items = await joplinNoteApi.loadLastNoteList()

    searchQuickPickBox.onDidChangeValue(async (value: string) => {
      if (value.trim() === '') {
        searchQuickPickBox.items = await joplinNoteApi.loadLastNoteList()
        return
      }
      const { items: noteList } = await searchApi.search({
        query: value,
        type: TypeEnum.Note,
        fields: ['id', 'title', 'body'],
        limit: 100,
        order_by: 'user_updated_time',
        order_dir: 'DESC',
      })
      GlobalContext.noteSearchProvider.setSearchList(value.trim(), noteList)
      searchQuickPickBox.items = noteList.map((note) => ({
        label: note.title,
        id: note.id,
        alwaysShow: true,
      }))
      // console.log('search: ', value, JSON.stringify(searchQuickPickBox.items))
    })
    searchQuickPickBox.onDidAccept(() => {
      const selectItem = searchQuickPickBox.selectedItems[0]
      GlobalContext.handlerService.openNote(selectItem.id)
    })
    searchQuickPickBox.show()
  }

  /**
   * 切换选中的文件时自动展开左侧的树
   * @param fileName
   */
  async onDidChangeActiveTextEditor(fileName?: string) {
    if (!this.config.noteListTreeView.visible) {
      return
    }
    const noteId = JoplinNoteUtil.getNoteIdByFileName(fileName)
    if (!noteId) {
      return
    }
    await Promise.all([this.focus(noteId), this.refreshResource(noteId)])
  }

  async showResources(fileName?: string) {
    const noteId = JoplinNoteUtil.getNoteIdByFileName(fileName)
    logger.warn('showResources.noteId: ' + noteId)
    if (!noteId) {
      return
    }
    const resources = await noteApi.resourcesById(noteId)
    const selectItem = await vscode.window.showQuickPick(
      resources.map((item) => ({
        label: item.title,
        resourceId: item.id,
      })),
    )
    logger.warn('showResources.selectItem: ' + JSON.stringify(selectItem))
    if (!selectItem) {
      return
    }
    await this.handlerService.openResource(selectItem.resourceId)
  }

  private async refreshResource(noteId: string) {
    console.log('refreshResource: ', noteId, this.config)
  }

  private async focus(noteId: string) {
    const note = await noteApi.get(noteId, ['id', 'parent_id', 'title', 'is_todo', 'todo_completed'])
    this.config.noteListTreeView.reveal(
      new JoplinTreeItem({
        ...note,
        type_: TypeEnum.Note,
      }),
    )
  }

  /**
   * 创建资源
   */
  async createResource() {
    const globalStoragePath = GlobalContext.context.globalStorageUri.fsPath
    const title = await vscode.window.showInputBox({
      placeHolder: t('Please enter what you want to create {{type}} name', {
        type: t('attachment'),
      }),
      value: '',
    })
    if (!title) {
      return
    }
    const filePath = path.resolve(globalStoragePath, `.tempResource/${title}`)
    const handle = await createEmptyFile(filePath)
    let { res, markdownLink } = await UploadResourceUtil.uploadByPath(filePath, false)
    // 如果是 svg 图片则作为图片插入
    if (path.extname(filePath) === '.svg') {
      markdownLink = '!' + markdownLink
    }
    await Promise.all([
      uploadResourceService.insertUrlByActiveEditor(markdownLink),
      uploadResourceService.refreshResourceList(res.id),
    ])
    if (await pathExists(filePath)) {
      await close(handle)
      await remove(filePath)
    }
    vscode.window.showInformationMessage(t('Attachment resource created successfully'))
    await this.handlerService.openResource(res.id)
  }

  /**
   * 删除附件
   */
  async removeResource() {
    const list = (
      await PageUtil.pageToAllList(resourceApi.list, {
        order_by: 'user_updated_time',
        order_dir: 'DESC',
      })
    ).map(
      (item) =>
        ({
          label: item.title,
          id: item.id,
        } as vscode.QuickPickItem & { id: string }),
    )
    const selectItemList = await vscode.window.showQuickPick(list, {
      canPickMany: true,
      placeHolder: '请选择要删除的附件资源',
    })
    if (!selectItemList || selectItemList.length === 0) {
      return
    }
    await Promise.all(selectItemList.map(async (item) => resourceApi.remove(item.id)))
    vscode.window.showInformationMessage(selectItemList.map((item) => item.label).join('\n'), {
      title: '删除附件成功',
    })
  }

  private clipboard: JoplinTreeItem | null = null

  /**
   * 剪切
   */
  cut(item: JoplinTreeItem = this.config.noteListTreeView.selection[0]) {
    console.log('joplin.cut: ', item)
    this.clipboard = item
    vscode.window.showInformationMessage(t('cut-success'))
  }

  /**
   * 粘贴
   */
  async paste(item: JoplinTreeItem = this.config.noteListTreeView.selection[0]) {
    const clipboard = this.clipboard?.item
    console.log('paste: ', clipboard, item)
    if (!clipboard) {
      vscode.window.showWarningMessage(t('paste-error-clipboardNotFound'))
      return
    }
    if (!item) {
      vscode.window.showWarningMessage(t('paste-error-itemNotFound'))
      return
    }
    if (item.item.type_ !== TypeEnum.Folder) {
      vscode.window.showWarningMessage(t('paste-error-targetNotDir'))
      return
    }
    if (clipboard.id === item.id) {
      vscode.window.showWarningMessage(t('paste-error-targetNotThis'))
      return
    }
    if (clipboard.type_ === TypeEnum.Folder) {
      const paths = await folderExtApi.path(item.id)
      console.log('paths: ', paths)
      if (paths.some((item) => item.id === clipboard.id)) {
        vscode.window.showWarningMessage(t('paste-error-canTPasteSub'))
        return
      }
      await folderExtApi.move(clipboard.id, item.id)
    } else {
      await noteExtApi.move(clipboard.id, item.id)
    }
    await this.config.noteViewProvider.refresh()
    vscode.window.showInformationMessage(t('paste-success'))
    this.clipboard = null
  }
}

import { fileURLToPath } from 'url'
import * as os from 'os'
import * as path from 'path'
import { createReadStream, mkdirpSync } from '@liuli-util/fs-extra'
import { spawn } from 'child_process'
import * as fs from '@liuli-util/fs-extra'
import { resourceApi } from 'joplin-api'

/**
 * for clipboard image
 */
export interface IClipboardImage {
  imgPath: string
  isExistFile: boolean
}

export class UploadResourceUtil {
  static async uploadByPath(filePath: string, isImage: boolean) {
    const param = {
      title: path.basename(filePath),
      data: createReadStream(path.resolve(filePath)),
    }
    console.log('uploadFromExplorer begin: ', filePath, param.title)
    const res = await resourceApi.create(param)
    const markdownLink = `${isImage ? '!' : ''}[${param.title}](:/${res.id})`
    console.log('uploadFromExplorer end: ', markdownLink)
    return { res, markdownLink }
  }

  static async uploadFileByPath(filePath: string) {
    const param = {
      title: path.basename(filePath),
      data: createReadStream(path.resolve(filePath)),
    }
    console.log('uploadFileFromExplorer begin: ', filePath, param.title)
    const res = await resourceApi.create(param)
    const markdownLink = `[${res.title}](:/${res.id})`
    console.log('uploadFileFromExplorer end: ', markdownLink)
    return { res, markdownLink }
  }

  static getCurrentPlatform(): string {
    const platform = process.platform
    if (platform !== 'win32') {
      return platform
    } else {
      const currentOS = os.release().split('.')[0]
      if (currentOS === '10') {
        return 'win10'
      } else {
        return 'win32'
      }
    }
  }

  // Thanks to vs-picgo: https://github.com/Spades-S/vs-picgo/blob/master/src/extension.ts
  static async getClipboardImage(fileDir: string): Promise<IClipboardImage> {
    const baseDir = path.resolve(fileDir, 'ClipboardImage')
    mkdirpSync(baseDir)
    const imagePath = path.resolve(baseDir, `${Date.now()}.png`)
    return await new Promise<IClipboardImage>((resolve, reject): void => {
      const platform: string = UploadResourceUtil.getCurrentPlatform()
      let execution
      // for PicGo GUI
      const platformPaths: {
        [index: string]: string
      } = {
        darwin: './clipboard/mac.applescript',
        win32: './clipboard/windows.ps1',
        win10: './clipboard/windows10.ps1',
        linux: './clipboard/linux.sh',
      }
      const scriptPath = path.join(__dirname, platformPaths[platform])
      try {
        if (platform === 'darwin') {
          execution = spawn('osascript', [scriptPath, imagePath])
        } else if (platform === 'win32' || platform === 'win10') {
          execution = spawn('powershell', [
            '-noprofile',
            '-noninteractive',
            '-nologo',
            '-sta',
            '-executionpolicy',
            'unrestricted',
            // fix windows 10 native cmd crash bug when "picgo upload"
            // https://github.com/PicGo/PicGo-Core/issues/32
            // '-windowstyle','hidden',
            // '-noexit',
            '-file',
            scriptPath,
            imagePath,
          ])
        } else {
          execution = spawn('sh', [scriptPath, imagePath])
        }
      } catch (err) {
        reject(err)
        throw err
      }
      execution.on('error', reject)
      execution.stdout.on('data', (data: Buffer) => {
        if (platform === 'linux') {
          if (data.toString().trim() === 'no xclip') {
            resolve({
              isExistFile: false,
              imgPath: 'xclip not found, Please install xclip before run picgo',
            })
            return
          }
        }
        const imgPath = data.toString().trim()
        let isExistFile = fs.existsSync(imgPath)
        // in macOS if your copy the file in system, it's basename will not equal to our default basename
        if (path.basename(imgPath) !== path.basename(imagePath)) {
          if (fs.existsSync(imgPath)) {
            isExistFile = true
          }
        }
        resolve({
          imgPath,
          isExistFile,
        })
      })
    })
  }
}

import * as vscode from 'vscode';
import * as htmlGenerator from './htmlGenerator';
import * as gitHistory from '../helpers/gitHistory';
import * as gitCherryPick from '../helpers/gitCherryPick';
import { LogEntry } from '../contracts';
import * as path from 'path';
import * as gitPaths from '../helpers/gitPaths';
import { decode as htmlDecode } from 'he';
import * as historyUtil from '../helpers/historyUtils';
import * as logger from '../logger';
import * as fileHistory from '../commands/fileHistory';

const gitHistorySchema = 'git-history-viewer';
const PAGE_SIZE = 50;
let previewUri = vscode.Uri.parse(gitHistorySchema + '://authority/git-history');
let pageIndex = 0;
let pageSize = PAGE_SIZE;
let canGoPrevious = false;
let canGoNext = true;
let gitRepoPath = vscode.workspace.rootPath;

class TextDocumentContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    private entries: LogEntry[];
    private html: Object = {};
    constructor() {}
    public async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
        try {
            let branchName = this.getBranchFromURI(uri);
            let searchText = this.getSearchFromURI(uri);
            let isSearch = (searchText !== '') ? true : false;
            if ( !isSearch && this.html.hasOwnProperty(branchName) ) {
                return this.html[branchName];
            }
            const entries = await gitHistory.getLogEntries(gitRepoPath!, branchName, searchText, pageIndex, pageSize);
            canGoPrevious = pageIndex > 0;
            canGoNext = entries.length === pageSize;
            this.entries = entries;
            this.html[branchName] = this.generateHistoryView( isSearch );
            return this.html[branchName];
        }
        catch (error) {
            return this.generateErrorView(error);
        }
    }

    get onDidChange(): vscode.Event<vscode.Uri> {
        return this._onDidChange.event;
    }

    public update(uri: vscode.Uri) {
        let branchName = this.getBranchFromURI(uri);
        this.clearCache(branchName);
        this._onDidChange.fire(uri);
    }

    private clearCache(name: string) {
        if (this.html.hasOwnProperty(name)) {
            delete this.html[name];
        }
    }

    private getBranchFromURI(uri: vscode.Uri): string {
        if (uri.query.length > 0) {
            let re = uri.query.match(/branch=([a-z0-9_\-.]+)/i);
            return (re) ? re[1] : 'master';
        } else {
            return '';
        }
    }

    private getSearchFromURI(uri: vscode.Uri): string {
        let re = uri.query.match(/search=([a-z0-9\s_\-.]+)/i);
        return (re) ? re[1] : '';
    }

    private getStyleSheetPath(resourceName: string): string {
        return vscode.Uri.file(path.join(__dirname, '..', '..', '..', 'resources', resourceName)).toString();
    }
    private getScriptFilePath(resourceName: string): string {
        return vscode.Uri.file(path.join(__dirname, '..', '..', 'src', 'browser', resourceName)).toString();
    }
    private getNodeModulesPath(resourceName: string): string {
        return vscode.Uri.file(path.join(__dirname, '..', '..', '..', 'node_modules', resourceName)).toString();
    }

    private generateErrorView(error: string): string {
        return `
            <head>
                <link rel="stylesheet" href="${this.getNodeModulesPath(path.join('normalize.css', 'normalize.css'))}" >
                <link rel="stylesheet" href="${this.getStyleSheetPath(path.join('octicons', 'font', 'octicons.css'))}" >
                <link rel="stylesheet" href="${this.getStyleSheetPath('animate.min.css')}" >
                <link rel="stylesheet" href="${this.getStyleSheetPath('main.css')}" >
            </head>
            <body>
                ${htmlGenerator.generateErrorView(error)}
            </body>
        `;
    }

    private generateHistoryView(skipGraph: boolean = false): string {
        const innerHtml = htmlGenerator.generateHistoryHtmlView(this.entries, canGoPrevious, canGoNext, skipGraph);
        return `
            <head>
                <link rel="stylesheet" href="${this.getNodeModulesPath(path.join('normalize.css', 'normalize.css'))}" >
                <link rel="stylesheet" href="${this.getStyleSheetPath(path.join('octicons', 'font', 'octicons.css'))}" >
                <link rel="stylesheet" href="${this.getStyleSheetPath('animate.min.css')}" >
                <link rel="stylesheet" href="${this.getStyleSheetPath('hint.min.css')}" >
                <link rel="stylesheet" href="${this.getStyleSheetPath('main.css')}" >
                <script src="${this.getNodeModulesPath(path.join('jquery', 'dist', 'jquery.min.js'))}"></script>
                <script src="${this.getNodeModulesPath(path.join('clipboard', 'dist', 'clipboard.min.js'))}"></script>
                <script src="${this.getScriptFilePath('proxy.js')}"></script>
                <script src="${this.getScriptFilePath('svgGenerator.js')}"></script>
                <script src="${this.getScriptFilePath('detailsView.js')}"></script>
            </head>

            <body>
                ${innerHtml}
            </body>
        `;
    }
}

export function activate(context: vscode.ExtensionContext, showLogEntries: (entries: LogEntry[]) => void) {
    let provider = new TextDocumentContentProvider();
    let registration = vscode.workspace.registerTextDocumentContentProvider(gitHistorySchema, provider);

    let disposable = vscode.commands.registerCommand('git.viewHistory', async (fileUri?: vscode.Uri, search?: string) => {
        const itemPickList: vscode.QuickPickItem[] = [];
        itemPickList.push({ label: 'Current branch', description: '' });
        itemPickList.push({ label: 'All branches', description: '' });
        let modeChoice = await vscode.window.showQuickPick(itemPickList, { placeHolder: 'Show history for...', matchOnDescription: true });

        let title = 'Git History (All Branches)';
        if (modeChoice === undefined) {
            return;
        }

        let fileName = '';

        if (fileUri && fileUri.fsPath) {
            fileName = fileUri.fsPath;
        }
        else {
            if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
                fileName = vscode.window.activeTextEditor.document.fileName;
            }
        }
        if (fileName !== '') {
            gitRepoPath = await gitPaths.getGitRepositoryPath(fileName);
        }
        else {
            gitRepoPath = vscode.workspace.rootPath;
        }

        pageIndex = 0;
        canGoPrevious = false;
        canGoNext = true;

        let branchName = '';
        let previewUriText = gitHistorySchema + '://authority/git-history';

        if (modeChoice.label === 'Current branch') {
            branchName = await gitPaths.getGitBranch(gitRepoPath!);
            previewUriText += '?branch=' + encodeURI(branchName);
            title = 'Git History (' + branchName + ')';
        }

        if (search !== undefined) {
            if (branchName === '') {
                title = 'Git Search (' + search + ')';
                previewUriText += '?';
            } else {
                title = 'Git Search in ' + branchName + ' (' + search + ')';
                previewUriText += '&';
            }
            previewUriText += 'search=' +  encodeURI(search);
        }

        previewUri = vscode.Uri.parse(previewUriText);

        return vscode.commands.executeCommand('vscode.previewHtml', previewUri, vscode.ViewColumn.One, title).then((success) => {
            provider.update(previewUri);
        }, (reason) => {
            vscode.window.showErrorMessage(reason);
        });
    });
    context.subscriptions.push(disposable, registration);

    disposable = vscode.commands.registerCommand('git.cherry-pick-into', (branch: string, sha: string) => {
        gitCherryPick.CherryPick(vscode.workspace.rootPath!, branch, sha).then((value) => {
            vscode.window.showInformationMessage('Cherry picked into ' + value.branch + ' (' + value.sha + ')');
        }, (reason) => {
            vscode.window.showErrorMessage(reason);
        });
    });
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('git.logNavigate', (direction: string) => {
        pageIndex = pageIndex + (direction === 'next' ? 1 : -1);
        provider.update(previewUri);
    });

    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('git.viewFileCommitDetails', async (sha1: string, relativeFilePath: string, isoStrictDateTime: string) => {
        try {
            relativeFilePath = htmlDecode(relativeFilePath);
            const fileName = path.join(gitRepoPath!, relativeFilePath);
            const data = await historyUtil.getFileHistoryBefore(gitRepoPath!, relativeFilePath, isoStrictDateTime);
            const historyItem: any = data.find(data => data.sha1 === sha1);
            const previousItems = data.filter(data => data.sha1 !== sha1);
            historyItem.previousSha1 = previousItems.length === 0 ? '' : previousItems[0].sha1 as string;
            const item: vscode.QuickPickItem = <vscode.QuickPickItem>{
                label: '',
                description: '',
                data: historyItem,
                isLast: historyItem.previousSha1.length === 0
            };
            fileHistory.onItemSelected(item, fileName, relativeFilePath);
        }
        catch (error) {
            logger.logError(error);
        }
    });

    context.subscriptions.push(disposable);
}
export function getGitRepoPath() {
    return gitRepoPath!;
}
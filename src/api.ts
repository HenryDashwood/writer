import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import type {
  ApiKeyService,
  ApiKeyStatus,
  ChatTurnRequest,
  ChatTurnResponse,
  DiffResolution,
  DocumentData,
  DocumentThreadsFileWire,
  EditPassRequest,
  EditPassResponse,
  FileChangeEvent,
  FileNode,
  MdxServerInfo,
  MutationResult,
  PangramCheckRequest,
  PangramCheckResponse,
  PromptConfig,
  ProposedEdit,
  ProviderStatus,
  ResolveOptions,
  SaveResult,
  SaveSkillInput,
  SaveSkillResult,
  SkillsCatalog,
} from "./types";

export async function pickWorkspaceFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Writing Folder",
  });
  return typeof selected === "string" ? selected : null;
}

export async function confirmAction(
  message: string,
  title: string,
): Promise<boolean> {
  try {
    return await ask(message, { title, kind: "warning" });
  } catch {
    return window.confirm(message);
  }
}

export function openWorkspace(
  path: string,
  showAllFiles = false,
): Promise<FileNode[]> {
  return invoke<FileNode[]>("open_workspace", { path, showAllFiles });
}

export function refreshWorkspace(
  path: string,
  showAllFiles = false,
): Promise<FileNode[]> {
  return invoke<FileNode[]>("refresh_workspace", { path, showAllFiles });
}

export function createFile(
  workspaceRoot: string,
  parentDir: string,
  name: string,
  showAllFiles = false,
): Promise<MutationResult> {
  return invoke<MutationResult>("create_file", {
    workspaceRoot,
    parentDir,
    name,
    showAllFiles,
  });
}

export function createFolder(
  workspaceRoot: string,
  parentDir: string,
  name: string,
  showAllFiles = false,
): Promise<MutationResult> {
  return invoke<MutationResult>("create_folder", {
    workspaceRoot,
    parentDir,
    name,
    showAllFiles,
  });
}

export function renameEntry(
  workspaceRoot: string,
  oldPath: string,
  newName: string,
  showAllFiles = false,
): Promise<MutationResult> {
  return invoke<MutationResult>("rename_entry", {
    workspaceRoot,
    oldPath,
    newName,
    showAllFiles,
  });
}

export function moveEntry(
  workspaceRoot: string,
  sourcePath: string,
  targetDir: string,
  showAllFiles = true,
): Promise<MutationResult> {
  return invoke<MutationResult>("move_entry", {
    workspaceRoot,
    sourcePath,
    targetDir,
    showAllFiles,
  });
}

export function copyEntry(
  workspaceRoot: string,
  sourcePath: string,
  targetDir: string,
  showAllFiles = true,
): Promise<MutationResult> {
  return invoke<MutationResult>("copy_entry", {
    workspaceRoot,
    sourcePath,
    targetDir,
    showAllFiles,
  });
}

export function duplicateFile(
  workspaceRoot: string,
  path: string,
  showAllFiles = true,
): Promise<MutationResult> {
  return invoke<MutationResult>("duplicate_file", {
    workspaceRoot,
    path,
    showAllFiles,
  });
}

export function trashEntry(
  workspaceRoot: string,
  path: string,
  showAllFiles = true,
): Promise<FileNode[]> {
  return invoke<FileNode[]>("trash_entry", {
    workspaceRoot,
    path,
    showAllFiles,
  });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke<void>("reveal_in_finder", { path });
}

export function openWithDefaultApp(path: string): Promise<void> {
  return invoke<void>("open_with_default_app", { path });
}

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await invoke<void>("copy_to_clipboard", { text });
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

export function readDocument(
  path: string,
  workspaceRoot: string | null,
): Promise<DocumentData> {
  return invoke<DocumentData>("read_document", {
    path,
    workspaceRoot,
  });
}

export function saveDocument(
  path: string,
  content: string,
): Promise<SaveResult> {
  return invoke<SaveResult>("save_document", { path, content });
}

export function resolveEdits(
  content: string,
  edits: ProposedEdit[],
  options?: ResolveOptions,
): Promise<DiffResolution> {
  return invoke<DiffResolution>("resolve_edits", {
    content,
    edits,
    options: options ?? null,
  });
}

export function checkProviders(): Promise<ProviderStatus> {
  return invoke<ProviderStatus>("check_providers");
}

export function listSkills(
  workspaceRoot: string | null,
): Promise<SkillsCatalog> {
  return invoke<SkillsCatalog>("list_skills", { workspaceRoot });
}

export function saveSkill(
  workspaceRoot: string | null,
  input: SaveSkillInput,
): Promise<SaveSkillResult> {
  return invoke<SaveSkillResult>("save_skill", { workspaceRoot, input });
}

export function deleteSkill(
  workspaceRoot: string | null,
  path: string,
): Promise<SkillsCatalog> {
  return invoke<SkillsCatalog>("delete_skill", { workspaceRoot, path });
}

export function getPromptConfig(): Promise<PromptConfig> {
  return invoke<PromptConfig>("get_prompt_config");
}

export function savePromptConfig(config: PromptConfig): Promise<PromptConfig> {
  return invoke<PromptConfig>("save_prompt_config", { config });
}

export function resetPromptConfig(): Promise<PromptConfig> {
  return invoke<PromptConfig>("reset_prompt_config");
}

export function getApiKeyStatus(
  workspaceRoot: string | null,
): Promise<ApiKeyStatus> {
  return invoke<ApiKeyStatus>("get_api_key_status", { workspaceRoot });
}

export function saveApiKey(
  service: ApiKeyService,
  key: string,
  workspaceRoot: string | null,
): Promise<ApiKeyStatus> {
  return invoke<ApiKeyStatus>("save_api_key", {
    service,
    key,
    workspaceRoot,
  });
}

export function clearApiKey(
  service: ApiKeyService,
  workspaceRoot: string | null,
): Promise<ApiKeyStatus> {
  return invoke<ApiKeyStatus>("clear_api_key", { service, workspaceRoot });
}

export function runPangramCheck(
  request: PangramCheckRequest,
): Promise<PangramCheckResponse> {
  return invoke<PangramCheckResponse>("run_pangram_check", { request });
}

export function loadDocumentThreads(
  filePath: string,
): Promise<DocumentThreadsFileWire> {
  return invoke<DocumentThreadsFileWire>("load_document_threads", { filePath });
}

export function saveDocumentThreads(
  data: DocumentThreadsFileWire,
): Promise<void> {
  return invoke<void>("save_document_threads", { data });
}

export function remapDocumentThreads(
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke<void>("remap_document_threads", { oldPath, newPath });
}

export function runEditPass(
  request: EditPassRequest,
): Promise<EditPassResponse> {
  return invoke<EditPassResponse>("run_edit_pass", { request });
}

export function runChatTurn(
  request: ChatTurnRequest,
): Promise<ChatTurnResponse> {
  return invoke<ChatTurnResponse>("run_chat_turn", { request });
}

export function ensureMdxServer(): Promise<MdxServerInfo> {
  return invoke<MdxServerInfo>("ensure_mdx_server");
}

export async function pushMdxBuffer(
  baseUrl: string,
  filePath: string,
  content: string,
): Promise<void> {
  await fetch(`${baseUrl}/buffer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filePath, content }),
  });
}

export function onWorkspaceFileChanged(
  handler: (event: FileChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<FileChangeEvent>("workspace-file-changed", (event) => {
    handler(event.payload);
  });
}

export function onWorkspaceTreeChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("workspace-tree-changed", () => {
    handler();
  });
}

export function onCheckForUpdates(handler: () => void): Promise<UnlistenFn> {
  return listen("check-for-updates", handler);
}

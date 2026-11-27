pub mod diff;
pub mod llm;
pub mod mdx_server;
pub mod mdx_spans;
pub mod pangram;
pub mod skills;
pub mod threads;
pub mod watcher;
pub mod workspace;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State};
#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    Emitter,
};
use tauri_plugin_updater::UpdaterExt;

use crate::diff::{DiffResolution, ProposedEdit, ResolveOptions};
use crate::llm::{
    ChatTurnRequest, ChatTurnResponse, EditPassRequest, EditPassResponse, PromptConfig,
    ProviderStatus,
};
use crate::mdx_server::{MdxServerInfo, MdxServerState};
use crate::mdx_spans::ProtectedSpan;
use crate::pangram::{ApiKeyService, ApiKeyStatus, PangramCheckRequest, PangramCheckResponse};
use crate::skills::{SaveSkillInput, SaveSkillResult, SkillsCatalog};
use crate::threads::DocumentThreadsFile;
use crate::watcher::WatcherState;
use crate::workspace::{DocumentData, FileNode, MutationResult, SaveResult};

#[cfg(target_os = "macos")]
const CHECK_FOR_UPDATES: &str = "check-for-updates";

/// Metadata returned to the frontend over Tauri IPC to verify the bridge.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
}

fn build_app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME").to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: format!("{} ({})", std::env::consts::OS, std::env::consts::ARCH),
    }
}

#[tauri::command]
fn get_app_info() -> AppInfo {
    build_app_info()
}

#[tauri::command]
fn scan_mdx_spans(content: String) -> Vec<ProtectedSpan> {
    mdx_spans::scan_protected_spans(&content)
}

#[tauri::command]
fn resolve_edits(
    content: String,
    edits: Vec<ProposedEdit>,
    options: Option<ResolveOptions>,
) -> DiffResolution {
    diff::resolve_edits(&content, edits, &options.unwrap_or_default())
}

#[tauri::command]
fn open_workspace(
    app: AppHandle,
    watcher: State<'_, WatcherState>,
    path: String,
    show_all_files: Option<bool>,
) -> Result<Vec<FileNode>, String> {
    let root = PathBuf::from(&path);
    let tree = workspace::scan_workspace(&root, show_all_files.unwrap_or(false))?;
    watcher.watch_workspace(app, &root)?;
    Ok(tree)
}

#[tauri::command]
fn refresh_workspace(
    path: String,
    show_all_files: Option<bool>,
) -> Result<Vec<FileNode>, String> {
    let root = PathBuf::from(&path);
    workspace::scan_workspace(&root, show_all_files.unwrap_or(false))
}

#[tauri::command]
fn create_file(
    watcher: State<'_, WatcherState>,
    workspace_root: String,
    parent_dir: String,
    name: String,
    show_all_files: Option<bool>,
) -> Result<MutationResult, String> {
    let root = PathBuf::from(&workspace_root);
    let parent = PathBuf::from(&parent_dir);
    let created = workspace::create_file(&root, &parent, &name)?;
    watcher.record_self_write(&created);
    let tree = workspace::scan_workspace(&root, show_all_files.unwrap_or(false))?;
    Ok(MutationResult {
        path: created.to_string_lossy().to_string(),
        tree,
    })
}

#[tauri::command]
fn create_folder(
    workspace_root: String,
    parent_dir: String,
    name: String,
    show_all_files: Option<bool>,
) -> Result<MutationResult, String> {
    let root = PathBuf::from(&workspace_root);
    let parent = PathBuf::from(&parent_dir);
    let created = workspace::create_folder(&root, &parent, &name)?;
    let tree = workspace::scan_workspace(&root, show_all_files.unwrap_or(false))?;
    Ok(MutationResult {
        path: created.to_string_lossy().to_string(),
        tree,
    })
}

#[tauri::command]
fn rename_entry(
    watcher: State<'_, WatcherState>,
    workspace_root: String,
    old_path: String,
    new_name: String,
    show_all_files: Option<bool>,
) -> Result<MutationResult, String> {
    let root = PathBuf::from(&workspace_root);
    let old = PathBuf::from(&old_path);
    let renamed = workspace::rename_entry(&root, &old, &new_name)?;
    watcher.record_self_write(&renamed);
    let tree = workspace::scan_workspace(&root, show_all_files.unwrap_or(false))?;
    Ok(MutationResult {
        path: renamed.to_string_lossy().to_string(),
        tree,
    })
}

#[tauri::command]
fn move_entry(
    watcher: State<'_, WatcherState>,
    workspace_root: String,
    source_path: String,
    target_dir: String,
    show_all_files: Option<bool>,
) -> Result<MutationResult, String> {
    let root = PathBuf::from(&workspace_root);
    let src = PathBuf::from(&source_path);
    let dst_dir = PathBuf::from(&target_dir);
    let moved = workspace::move_entry(&root, &src, &dst_dir)?;
    watcher.record_self_write(&moved);
    let tree = workspace::scan_workspace(&root, show_all_files.unwrap_or(false))?;
    Ok(MutationResult {
        path: moved.to_string_lossy().to_string(),
        tree,
    })
}

#[tauri::command]
fn copy_entry(
    watcher: State<'_, WatcherState>,
    workspace_root: String,
    source_path: String,
    target_dir: String,
    show_all_files: Option<bool>,
) -> Result<MutationResult, String> {
    let root = PathBuf::from(&workspace_root);
    let src = PathBuf::from(&source_path);
    let dst_dir = PathBuf::from(&target_dir);
    let copied = workspace::copy_entry(&root, &src, &dst_dir)?;
    watcher.record_self_write(&copied);
    let tree = workspace::scan_workspace(&root, show_all_files.unwrap_or(true))?;
    Ok(MutationResult {
        path: copied.to_string_lossy().to_string(),
        tree,
    })
}

#[tauri::command]
fn duplicate_file(
    watcher: State<'_, WatcherState>,
    workspace_root: String,
    path: String,
    show_all_files: Option<bool>,
) -> Result<MutationResult, String> {
    let root = PathBuf::from(&workspace_root);
    let src = PathBuf::from(&path);
    let copy = workspace::duplicate_file(&root, &src)?;
    watcher.record_self_write(&copy);
    let tree = workspace::scan_workspace(&root, show_all_files.unwrap_or(false))?;
    Ok(MutationResult {
        path: copy.to_string_lossy().to_string(),
        tree,
    })
}

#[tauri::command]
fn trash_entry(
    workspace_root: String,
    path: String,
    show_all_files: Option<bool>,
) -> Result<Vec<FileNode>, String> {
    let root = PathBuf::from(&workspace_root);
    let target = PathBuf::from(&path);
    workspace::trash_entry(&root, &target)?;
    workspace::scan_workspace(&root, show_all_files.unwrap_or(false))
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    workspace::reveal_in_finder(&PathBuf::from(path))
}

#[tauri::command]
fn open_with_default_app(path: String) -> Result<(), String> {
    workspace::open_with_default_app(&PathBuf::from(path))
}

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    workspace::copy_to_clipboard(&text)
}

#[tauri::command]
fn read_document(path: String, workspace_root: Option<String>) -> Result<DocumentData, String> {
    let file_path = PathBuf::from(path);
    let root_path = workspace_root.map(PathBuf::from);
    workspace::read_document(&file_path, root_path.as_deref())
}

#[tauri::command]
fn save_document(
    watcher: State<'_, WatcherState>,
    path: String,
    content: String,
) -> Result<SaveResult, String> {
    let file_path = PathBuf::from(&path);
    watcher.record_self_write(&file_path);
    workspace::write_file_atomic(&file_path, &content)?;
    watcher.record_self_write(&file_path);

    Ok(SaveResult {
        path,
        outline: workspace::extract_outline(&content),
        metadata: workspace::extract_page_metadata(&file_path, &content),
        word_count: workspace::count_prose_words(&content),
    })
}

#[tauri::command]
fn check_providers() -> ProviderStatus {
    llm::check_providers()
}

#[tauri::command]
fn list_skills(app: AppHandle, workspace_root: Option<String>) -> SkillsCatalog {
    let app_dir = skills::resolve_app_skills_dir(&app);
    let ws = workspace_root.map(PathBuf::from);
    skills::load_skills_catalog(&app_dir, ws.as_deref())
}

#[tauri::command]
fn save_skill(
    app: AppHandle,
    workspace_root: Option<String>,
    input: SaveSkillInput,
) -> Result<SaveSkillResult, String> {
    let app_dir = skills::resolve_app_skills_dir(&app);
    let ws = workspace_root.map(PathBuf::from);
    skills::save_skill(&app_dir, ws.as_deref(), input)
}

#[tauri::command]
fn delete_skill(
    app: AppHandle,
    workspace_root: Option<String>,
    path: String,
) -> Result<SkillsCatalog, String> {
    let app_dir = skills::resolve_app_skills_dir(&app);
    let ws = workspace_root.map(PathBuf::from);
    skills::delete_skill(&app_dir, ws.as_deref(), &path)
}

#[tauri::command]
fn get_prompt_config(app: AppHandle) -> PromptConfig {
    let path = llm::resolve_prompt_config_path(&app);
    llm::load_prompt_config(&path)
}

#[tauri::command]
fn save_prompt_config(app: AppHandle, config: PromptConfig) -> Result<PromptConfig, String> {
    let path = llm::resolve_prompt_config_path(&app);
    llm::save_prompt_config(&path, &config)
}

#[tauri::command]
fn reset_prompt_config(app: AppHandle) -> Result<PromptConfig, String> {
    let path = llm::resolve_prompt_config_path(&app);
    llm::reset_prompt_config(&path)
}

#[tauri::command]
async fn run_edit_pass(request: EditPassRequest) -> Result<EditPassResponse, String> {
    llm::run_edit_pass(request).await
}

#[tauri::command]
fn get_api_key_status(app: AppHandle, workspace_root: Option<String>) -> ApiKeyStatus {
    let secrets_path = pangram::resolve_secrets_path(&app);
    let ws = workspace_root.map(PathBuf::from);
    pangram::get_api_key_status(&secrets_path, ws.as_deref())
}

#[tauri::command]
fn save_api_key(
    app: AppHandle,
    service: ApiKeyService,
    key: String,
    workspace_root: Option<String>,
) -> Result<ApiKeyStatus, String> {
    let secrets_path = pangram::resolve_secrets_path(&app);
    let ws = workspace_root.map(PathBuf::from);
    pangram::save_api_key(&secrets_path, service, &key, ws.as_deref())
}

#[tauri::command]
fn clear_api_key(
    app: AppHandle,
    service: ApiKeyService,
    workspace_root: Option<String>,
) -> Result<ApiKeyStatus, String> {
    let secrets_path = pangram::resolve_secrets_path(&app);
    let ws = workspace_root.map(PathBuf::from);
    pangram::clear_api_key(&secrets_path, service, ws.as_deref())
}

#[tauri::command]
async fn run_pangram_check(
    app: AppHandle,
    request: PangramCheckRequest,
) -> Result<PangramCheckResponse, String> {
    let secrets_path = pangram::resolve_secrets_path(&app);
    pangram::run_pangram_check(&secrets_path, request).await
}

#[tauri::command]
async fn run_chat_turn(
    app: AppHandle,
    mut request: ChatTurnRequest,
) -> Result<ChatTurnResponse, String> {
    if request.prompt_config.is_none() {
        let path = llm::resolve_prompt_config_path(&app);
        request.prompt_config = Some(llm::load_prompt_config(&path));
    }
    if request
        .api_key
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        let secrets_path = pangram::resolve_secrets_path(&app);
        if let Some((saved_key, _)) =
            pangram::resolve_api_key(&secrets_path, ApiKeyService::Anthropic, None)
        {
            request.api_key = Some(saved_key);
        }
    }
    llm::run_chat_turn(request).await
}

#[tauri::command]
fn load_document_threads(app: AppHandle, file_path: String) -> DocumentThreadsFile {
    let dir = threads::resolve_threads_dir(&app);
    threads::load_document_threads(&dir, &file_path)
}

#[tauri::command]
fn save_document_threads(app: AppHandle, data: DocumentThreadsFile) -> Result<(), String> {
    let dir = threads::resolve_threads_dir(&app);
    threads::save_document_threads(&dir, data)
}

#[tauri::command]
fn remap_document_threads(
    app: AppHandle,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let dir = threads::resolve_threads_dir(&app);
    threads::remap_document_threads(&dir, &old_path, &new_path)
}

#[tauri::command]
fn ensure_mdx_server(
    app: AppHandle,
    mdx_server: State<'_, MdxServerState>,
) -> Result<MdxServerInfo, String> {
    mdx_server.ensure_running(&app)
}

#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    updater
        .check()
        .await
        .map(|update| update.map(|update| update.version))
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn install_update(app: AppHandle, version: String) -> Result<(), String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    let update = updater.check().await.map_err(|err| err.to_string())?;
    let update = update
        .filter(|update| update.version == version)
        .ok_or("The available update changed. Check for updates again.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn restart_writer(app: AppHandle) {
    app.request_restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            let menu = Menu::default(app)?;
            // The first submenu on macOS is the application's menu.
            if let Some(MenuItemKind::Submenu(writer)) = menu.items()?.into_iter().next() {
                let check = MenuItem::with_id(
                    app,
                    CHECK_FOR_UPDATES,
                    "Check for Updates…",
                    !tauri::is_dev(),
                    None::<&str>,
                )?;
                writer.insert(&check, 1)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == CHECK_FOR_UPDATES {
                let _ = app.emit_to("main", CHECK_FOR_UPDATES, ());
            }
        });

    let app = builder
        .manage(WatcherState::default())
        .manage(MdxServerState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            scan_mdx_spans,
            resolve_edits,
            open_workspace,
            refresh_workspace,
            create_file,
            create_folder,
            rename_entry,
            move_entry,
            copy_entry,
            duplicate_file,
            trash_entry,
            reveal_in_finder,
            open_with_default_app,
            copy_to_clipboard,
            read_document,
            save_document,
            check_providers,
            list_skills,
            save_skill,
            delete_skill,
            get_prompt_config,
            save_prompt_config,
            reset_prompt_config,
            get_api_key_status,
            save_api_key,
            clear_api_key,
            run_pangram_check,
            load_document_threads,
            save_document_threads,
            remap_document_threads,
            run_edit_pass,
            run_chat_turn,
            ensure_mdx_server,
            check_for_update,
            install_update,
            restart_writer,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Writer");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<MdxServerState>() {
                state.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_populates_package_metadata() {
        let info = build_app_info();
        assert_eq!(info.name, "writer");
        assert_eq!(info.version, "0.1.0");
        assert!(!info.platform.is_empty());
    }
}

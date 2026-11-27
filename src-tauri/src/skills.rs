use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::workspace::write_file_atomic;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    App,
    Workspace,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillRunner {
    #[default]
    Llm,
    Pangram,
}

/// A reusable editorial skill loaded from a Markdown file (`<slug>.md` or `<slug>/SKILL.md`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Skill {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub allow_edits: bool,
    #[serde(default)]
    pub runner: SkillRunner,
    pub default_prompt: String,
    pub instructions: String,
    pub source: SkillSource,
    pub path: String,
    pub order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveSkillInput {
    /// Existing path on disk when editing; `None` when creating a brand-new skill.
    pub existing_path: Option<String>,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub allow_edits: bool,
    #[serde(default)]
    pub runner: SkillRunner,
    pub default_prompt: String,
    pub instructions: String,
    pub source: SkillSource,
    #[serde(default = "default_order")]
    pub order: i32,
}

fn default_order() -> i32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveSkillResult {
    pub skill: Skill,
    pub catalog: SkillsCatalog,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillsCatalog {
    pub skills: Vec<Skill>,
    pub app_skills_dir: String,
    pub workspace_skills_dir: Option<String>,
}

/// Copies any bundled default skills into the user's writable Application Support
/// skills folder on first launch without overwriting user edits.
fn seed_default_skills(bundled_dir: &Path, target_dir: &Path) {
    let Ok(entries) = fs::read_dir(bundled_dir) else {
        return;
    };
    let _ = fs::create_dir_all(target_dir);
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        let dst = target_dir.join(entry.file_name());
        if !dst.exists() {
            let _ = fs::copy(&src, &dst);
        }
    }
}

/// Resolves the writable app skills folder:
/// - In dev builds (`debug_assertions`): `<repo>/skills` so edits save right into the repo.
/// - In release `.app` bundles: `~/Library/Application Support/.../skills`, seeded from
///   the bundled default skills in `Contents/Resources/skills` on first run.
pub fn resolve_app_skills_dir(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("skills"));
        if let Some(dir) = dev_dir {
            if dir.is_dir() {
                return dir;
            }
        }
    }

    if let Ok(cfg_dir) = app.path().app_config_dir() {
        let user_skills = cfg_dir.join("skills");
        let _ = fs::create_dir_all(&user_skills);
        if let Ok(res_dir) = app.path().resource_dir() {
            let bundled = res_dir.join("skills");
            if bundled.is_dir() {
                seed_default_skills(&bundled, &user_skills);
            }
        }
        return user_skills;
    }

    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("skills");
        if bundled.is_dir() {
            return bundled;
        }
    }

    PathBuf::from("skills")
}

/// Loads skills from the app `skills/` folder and merges any workspace overrides/additions
/// found under `<workspace>/.writer/skills/`.
pub fn load_skills_catalog(app_dir: &Path, workspace_root: Option<&Path>) -> SkillsCatalog {
    let mut by_slug: HashMap<String, Skill> = HashMap::new();

    for skill in scan_skills_dir(app_dir, SkillSource::App) {
        by_slug.insert(skill.slug.clone(), skill);
    }

    let workspace_skills_dir = workspace_root.map(|root| root.join(".writer").join("skills"));
    if let Some(ws_dir) = workspace_skills_dir.as_deref() {
        if ws_dir.is_dir() {
            for skill in scan_skills_dir(ws_dir, SkillSource::Workspace) {
                by_slug.insert(skill.slug.clone(), skill);
            }
        }
    }

    let mut skills: Vec<Skill> = by_slug.into_values().collect();
    skills.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.slug.cmp(&b.slug)));

    SkillsCatalog {
        skills,
        app_skills_dir: app_dir.to_string_lossy().to_string(),
        workspace_skills_dir: workspace_skills_dir
            .filter(|p| p.is_dir())
            .map(|p| p.to_string_lossy().to_string()),
    }
}

/// Scans a directory for either `<slug>.md` files or `<slug>/SKILL.md` folders.
fn scan_skills_dir(dir: &Path, source: SkillSource) -> Vec<Skill> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') || file_name.eq_ignore_ascii_case("README.md") {
            continue;
        }

        if path.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if let Some(skill) = parse_skill_file(&path, stem, source) {
                    skills.push(skill);
                }
            }
        } else if path.is_dir() {
            let nested = path.join("SKILL.md");
            if nested.is_file() {
                if let Some(skill) = parse_skill_file(&nested, &file_name, source) {
                    skills.push(skill);
                }
            }
        }
    }

    skills
}

fn normalize_slug(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('/')
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn title_case_slug(slug: &str) -> String {
    slug.split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_quotes(val: &str) -> String {
    let trimmed = val.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

/// Parses a Markdown skill file with optional YAML frontmatter (`--- ... ---`).
pub fn parse_skill_markdown(
    content: &str,
    fallback_slug: &str,
    path: &Path,
    source: SkillSource,
) -> Option<Skill> {
    let mut slug = normalize_slug(fallback_slug);
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut allow_edits = true;
    let mut runner = SkillRunner::Llm;
    let mut default_prompt: Option<String> = None;
    let mut order: i32 = 100;

    let body = if let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    {
        if let Some(end_idx) = rest.find("\n---").or_else(|| rest.find("\r\n---")) {
            let fm = &rest[..end_idx];
            for line in fm.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = trimmed.split_once(':') {
                    let key = k.trim().to_lowercase();
                    let val = strip_quotes(v);
                    match key.as_str() {
                        "slug" | "command" if !val.is_empty() => slug = normalize_slug(&val),
                        "name" | "title" if !val.is_empty() => name = Some(val),
                        "description" if !val.is_empty() => description = Some(val),
                        "allow_edits" => {
                            allow_edits = !matches!(
                                val.to_lowercase().as_str(),
                                "false" | "no" | "0"
                            );
                        }
                        "runner" => {
                            runner = match val.to_lowercase().as_str() {
                                "pangram" => SkillRunner::Pangram,
                                _ => SkillRunner::Llm,
                            };
                        }
                        "default_prompt" | "prompt" if !val.is_empty() => {
                            default_prompt = Some(val);
                        }
                        "order" => {
                            if let Ok(parsed) = val.parse::<i32>() {
                                order = parsed;
                            }
                        }
                        _ => {}
                    }
                }
            }
            let after_marker = &rest[end_idx..];
            after_marker
                .find('\n')
                .and_then(|first_nl| after_marker[first_nl + 1..].find('\n').map(|n| first_nl + 1 + n + 1))
                .map(|body_start| &after_marker[body_start..])
                .unwrap_or("")
        } else {
            content
        }
    } else {
        content
    };

    let instructions = body.trim().to_string();
    if slug.is_empty() || instructions.is_empty() {
        return None;
    }

    let resolved_name = name.unwrap_or_else(|| title_case_slug(&slug));
    let resolved_description = description.unwrap_or_else(|| {
        instructions
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or(&resolved_name)
            .trim()
            .trim_start_matches(['#', '-', '*', ' '])
            .to_string()
    });
    let resolved_prompt =
        default_prompt.unwrap_or_else(|| format!("Run the {} skill on this draft.", resolved_name));

    Some(Skill {
        slug,
        name: resolved_name,
        description: resolved_description,
        allow_edits,
        runner,
        default_prompt: resolved_prompt,
        instructions,
        source,
        path: path.to_string_lossy().to_string(),
        order,
    })
}

fn parse_skill_file(path: &Path, fallback_slug: &str, source: SkillSource) -> Option<Skill> {
    let content = fs::read_to_string(path).ok()?;
    parse_skill_markdown(&content, fallback_slug, path, source)
}

fn format_yaml_value(val: &str) -> String {
    let trimmed = val.trim();
    let needs_quotes = trimmed.is_empty()
        || trimmed.contains(':')
        || trimmed.contains('#')
        || trimmed.starts_with(['"', '\'', '-', '[', '{', '*', '&', '!', '|', '>']);
    if needs_quotes {
        let escaped = trimmed.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    } else {
        trimmed.to_string()
    }
}

/// Renders a `Skill` back into clean YAML-frontmatter Markdown.
pub fn serialize_skill_markdown(input: &SaveSkillInput) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", format_yaml_value(&input.name)));
    out.push_str(&format!(
        "description: {}\n",
        format_yaml_value(&input.description)
    ));
    out.push_str(&format!("order: {}\n", input.order));
    out.push_str(&format!(
        "allow_edits: {}\n",
        if input.allow_edits { "true" } else { "false" }
    ));
    if input.runner != SkillRunner::Llm {
        let runner_name = match input.runner {
            SkillRunner::Llm => "llm",
            SkillRunner::Pangram => "pangram",
        };
        out.push_str(&format!("runner: {runner_name}\n"));
    }
    out.push_str(&format!(
        "default_prompt: {}\n",
        format_yaml_value(&input.default_prompt)
    ));
    out.push_str("---\n\n");
    out.push_str(input.instructions.trim());
    out.push('\n');
    out
}

fn is_path_inside_dir(path: &Path, dir: &Path) -> bool {
    let Ok(canon_dir) = fs::canonicalize(dir) else {
        return false;
    };
    let Ok(canon_path) = fs::canonicalize(path) else {
        return false;
    };
    canon_path.starts_with(&canon_dir)
}

/// Creates or updates a skill `.md` file atomically inside either the app `skills/` folder
/// or `<workspace>/.writer/skills/`.
pub fn save_skill(
    app_dir: &Path,
    workspace_root: Option<&Path>,
    mut input: SaveSkillInput,
) -> Result<SaveSkillResult, String> {
    input.slug = normalize_slug(&input.slug);
    if input.slug.is_empty() {
        return Err("Skill command slug cannot be empty (use letters, numbers, or hyphens).".into());
    }
    if input.instructions.trim().is_empty() {
        return Err("Skill prompt instructions cannot be empty.".into());
    }
    if input.name.trim().is_empty() {
        input.name = title_case_slug(&input.slug);
    }

    let target_dir = match input.source {
        SkillSource::App => app_dir.to_path_buf(),
        SkillSource::Workspace => {
            let root = workspace_root
                .ok_or_else(|| "Open a workspace folder before saving a workspace skill.".to_string())?;
            root.join(".writer").join("skills")
        }
    };
    fs::create_dir_all(&target_dir)
        .map_err(|err| format!("Failed to create skills directory: {err}"))?;

    let target_path = if let Some(existing_str) = input.existing_path.as_deref() {
        let existing = PathBuf::from(existing_str);
        if !is_path_inside_dir(&existing, &target_dir) {
            return Err("Refused to write outside the skills directory.".into());
        }
        // Keep `<slug>/SKILL.md` in place if it was a folder skill; otherwise rename `<old>.md` -> `<new>.md`.
        if existing
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("SKILL.md"))
        {
            existing
        } else {
            let desired = target_dir.join(format!("{}.md", input.slug));
            if desired != existing {
                if desired.exists() {
                    return Err(format!("A skill named `/{}` already exists.", input.slug));
                }
                fs::rename(&existing, &desired)
                    .map_err(|err| format!("Failed to rename skill file: {err}"))?;
            }
            desired
        }
    } else {
        let desired = target_dir.join(format!("{}.md", input.slug));
        if desired.exists() {
            return Err(format!("A skill named `/{}` already exists.", input.slug));
        }
        desired
    };

    let markdown = serialize_skill_markdown(&input);
    write_file_atomic(&target_path, &markdown)?;

    let skill = parse_skill_file(&target_path, &input.slug, input.source)
        .ok_or_else(|| "Saved skill file could not be re-parsed.".to_string())?;
    let catalog = load_skills_catalog(app_dir, workspace_root);

    Ok(SaveSkillResult { skill, catalog })
}

/// Moves a skill file (or `<slug>/` folder for `SKILL.md`) to Trash after verifying
/// it resides inside either the app skills folder or `<workspace>/.writer/skills/`.
pub fn delete_skill(
    app_dir: &Path,
    workspace_root: Option<&Path>,
    path_str: &str,
) -> Result<SkillsCatalog, String> {
    let target = PathBuf::from(path_str);
    let ws_dir = workspace_root.map(|r| r.join(".writer").join("skills"));

    let allowed = is_path_inside_dir(&target, app_dir)
        || ws_dir
            .as_deref()
            .is_some_and(|dir| is_path_inside_dir(&target, dir));

    if !allowed {
        return Err("Refused to delete a file outside the skills directories.".into());
    }

    let to_trash = if target
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("SKILL.md"))
    {
        target.parent().map(Path::to_path_buf).unwrap_or(target)
    } else {
        target
    };

    trash::delete(&to_trash).map_err(|err| format!("Failed to move skill to Trash: {err}"))?;
    Ok(load_skills_catalog(app_dir, workspace_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_repo_builtin_skills_in_order() {
        let app_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("skills");
        let catalog = load_skills_catalog(&app_dir, None);
        let slugs: Vec<&str> = catalog.skills.iter().map(|s| s.slug.as_str()).collect();
        assert_eq!(
            slugs,
            vec![
                "proofread",
                "tighten",
                "line-edit",
                "critique",
                "pangram",
                "socratic"
            ]
        );
        assert!(catalog.skills[0].allow_edits);
        assert!(!catalog.skills[3].allow_edits);
        assert_eq!(catalog.skills[4].runner, SkillRunner::Pangram);
    }

    #[test]
    fn parses_frontmatter_and_supports_workspace_override() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp = std::env::temp_dir().join(format!("writer-skills-test-{stamp}"));
        let app_dir = tmp.join("app_skills");
        let ws_root = tmp.join("ws");
        let ws_skills = ws_root.join(".writer").join("skills");
        fs::create_dir_all(&app_dir).unwrap();
        fs::create_dir_all(ws_skills.join("fact-check")).unwrap();

        fs::write(
            app_dir.join("proofread.md"),
            "---\nname: Proofread\ndescription: App proofread\norder: 1\n---\nFix typos.",
        )
        .unwrap();
        fs::write(
            ws_skills.join("proofread.md"),
            "---\nname: Proofread\ndescription: Workspace override\norder: 1\n---\nFix typos in UK English.",
        )
        .unwrap();
        fs::write(
            ws_skills.join("fact-check").join("SKILL.md"),
            "---\nname: Fact Check\ndescription: Flag unsupported claims\nallow_edits: false\n---\nCheck factual claims.",
        )
        .unwrap();

        let catalog = load_skills_catalog(&app_dir, Some(&ws_root));
        assert_eq!(catalog.skills.len(), 2);

        let proofread = catalog.skills.iter().find(|s| s.slug == "proofread").unwrap();
        assert_eq!(proofread.source, SkillSource::Workspace);
        assert_eq!(proofread.description, "Workspace override");

        let fact_check = catalog.skills.iter().find(|s| s.slug == "fact-check").unwrap();
        assert!(!fact_check.allow_edits);
        assert_eq!(fact_check.source, SkillSource::Workspace);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn creates_updates_and_roundtrips_skill_markdown() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp = std::env::temp_dir().join(format!("writer-skills-save-{stamp}"));
        let app_dir = tmp.join("skills");
        fs::create_dir_all(&app_dir).unwrap();

        let created = save_skill(
            &app_dir,
            None,
            SaveSkillInput {
                existing_path: None,
                slug: "fact-check".into(),
                name: "Fact Check".into(),
                description: "Check claims: dates, numbers, and citations".into(),
                allow_edits: false,
                runner: SkillRunner::Llm,
                default_prompt: "Audit factual claims in this draft.".into(),
                instructions: "Flag any claim that needs a citation.".into(),
                source: SkillSource::App,
                order: 10,
            },
        )
        .unwrap();

        assert_eq!(created.skill.slug, "fact-check");
        assert!(!created.skill.allow_edits);
        assert_eq!(
            created.skill.description,
            "Check claims: dates, numbers, and citations"
        );
        assert_eq!(created.catalog.skills.len(), 1);

        // Update slug & instructions in place.
        let updated = save_skill(
            &app_dir,
            None,
            SaveSkillInput {
                existing_path: Some(created.skill.path.clone()),
                slug: "verify-claims".into(),
                name: "Verify Claims".into(),
                description: "Audit factual accuracy".into(),
                allow_edits: false,
                runner: SkillRunner::Llm,
                default_prompt: "Check every claim.".into(),
                instructions: "List claims that need primary sources.".into(),
                source: SkillSource::App,
                order: 10,
            },
        )
        .unwrap();

        assert_eq!(updated.skill.slug, "verify-claims");
        assert!(PathBuf::from(&updated.skill.path).is_file());
        assert!(!PathBuf::from(&created.skill.path).exists());

        let _ = fs::remove_dir_all(&tmp);
    }
}

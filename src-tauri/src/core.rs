use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::harness::{bundled_dsh_entry, bundled_dsh_root, bundled_dsh_version, current_platform};

const CATALOG_JSON: &str = include_str!("../resources/core-catalog.json");
const BUILTIN_CORE_ID: &str = "builtin";
const CORE_ENTRY: &str = "node_modules/@deepseek-ai/dsh/lib/bin.js";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCatalogItem {
    pub id: String,
    pub version: String,
    pub release_tag: String,
    pub source_url: String,
    pub published_at: String,
    pub assets: HashMap<String, CoreAsset>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAsset {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreVersion {
    pub id: String,
    pub version: String,
    pub release_tag: String,
    pub source_url: String,
    pub published_at: String,
    pub installed: bool,
    pub active: bool,
    pub bundled: bool,
    pub supported: bool,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreActionResult {
    pub version: String,
    pub restarted: bool,
    pub launch: Option<crate::harness::HarnessLaunchInfo>,
}

#[derive(Clone)]
pub struct CoreManager {
    catalog: Arc<Vec<CoreCatalogItem>>,
    operation_lock: Arc<Mutex<()>>,
}

impl Default for CoreManager {
    fn default() -> Self {
        let catalog = serde_json::from_str(CATALOG_JSON).unwrap_or_default();
        Self {
            catalog: Arc::new(catalog),
            operation_lock: Arc::new(Mutex::new(())),
        }
    }
}

impl CoreManager {
    pub fn versions(&self, app: &AppHandle) -> Vec<CoreVersion> {
        let active_id = self.active_id(app);
        let bundled_version = bundled_dsh_version(app);
        let platform = current_platform();
        let builtin = CoreVersion {
            id: BUILTIN_CORE_ID.to_string(),
            version: bundled_version,
            release_tag: "应用内置".to_string(),
            source_url: "https://github.com/deepseek-ai/deepseek-harness".to_string(),
            published_at: String::new(),
            installed: bundled_dsh_entry(app).is_file(),
            active: active_id == BUILTIN_CORE_ID,
            bundled: true,
            supported: true,
            size: 0,
        };
        let mut versions = Vec::new();

        for item in self.catalog.iter() {
            if item.version == builtin.version {
                versions.push(builtin.clone());
                continue;
            }
            let asset = item.assets.get(platform);
            versions.push(CoreVersion {
                id: item.id.clone(),
                version: item.version.clone(),
                release_tag: item.release_tag.clone(),
                source_url: item.source_url.clone(),
                published_at: item.published_at.clone(),
                installed: self.core_entry(app, item).is_file(),
                active: active_id == item.id,
                bundled: false,
                supported: asset.is_some(),
                size: asset.map(|item| item.size).unwrap_or_default(),
            });
        }
        if !versions.iter().any(|version| version.bundled) {
            versions.push(builtin);
        }
        versions
    }

    pub fn install(&self, app: &AppHandle, id: &str) -> Result<CoreVersion, String> {
        let item = self
            .catalog
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| format!("不支持的 Harness 核心版本：{id}"))?;
        let platform = current_platform();
        let asset = item
            .assets
            .get(platform)
            .cloned()
            .ok_or_else(|| format!("核心版本 {} 不支持当前平台：{platform}", item.version))?;
        let final_dir = self.core_dir(app, &item)?;
        if final_dir.join(CORE_ENTRY).is_file() {
            return self
                .versions(app)
                .into_iter()
                .find(|version| version.id == id)
                .ok_or_else(|| "核心版本状态读取失败".to_string());
        }

        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| "核心版本操作锁不可用".to_string())?;
        if final_dir.join(CORE_ENTRY).is_file() {
            return self
                .versions(app)
                .into_iter()
                .find(|version| version.id == id)
                .ok_or_else(|| "核心版本状态读取失败".to_string());
        }

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
        let dependencies_dir = data_dir.join("dependencies");
        fs::create_dir_all(&dependencies_dir)
            .map_err(|error| format!("无法创建核心版本目录：{error}"))?;
        let stamp = timestamp();
        let archive_path = dependencies_dir.join(format!(".dsh-{id}-{stamp}.zip"));
        let staging_dir = dependencies_dir.join(format!(".dsh-{id}-{stamp}.staging"));

        let result = self.download_and_extract(&asset, &archive_path, &staging_dir, &item);
        let _ = fs::remove_file(&archive_path);
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(error);
        }

        if final_dir.exists() {
            fs::remove_dir_all(&final_dir)
                .map_err(|error| format!("无法替换损坏的核心版本目录：{error}"))?;
        }
        let extracted_root = find_core_root(&staging_dir)
            .ok_or_else(|| "核心压缩包中找不到 dsh 入口".to_string())?;
        fs::rename(&extracted_root, &final_dir)
            .map_err(|error| format!("无法安装 Harness 核心版本：{error}"))?;
        let _ = fs::remove_dir_all(&staging_dir);

        self.versions(app)
            .into_iter()
            .find(|version| version.id == id)
            .ok_or_else(|| "核心版本安装完成，但状态读取失败".to_string())
    }

    pub fn activate(&self, app: &AppHandle, id: &str) -> Result<String, String> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| "核心版本操作锁不可用".to_string())?;
        if id != BUILTIN_CORE_ID {
            let item = self
                .catalog
                .iter()
                .find(|item| item.id == id)
                .ok_or_else(|| format!("不支持的 Harness 核心版本：{id}"))?;
            if !self.core_entry(app, item).is_file() {
                return Err(format!("核心版本尚未安装：{}", item.version));
            }
        }
        self.write_active_id(app, id)?;
        Ok(self.active_version(app))
    }

    pub fn remove(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        if id == BUILTIN_CORE_ID {
            return Err("内置核心不能删除".to_string());
        }
        let item = self
            .catalog
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(|| format!("不支持的 Harness 核心版本：{id}"))?;
        if self.active_id(app) == id {
            return Err("当前使用的核心不能删除，请先切换到其他版本".to_string());
        }
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| "核心版本操作锁不可用".to_string())?;
        let path = self.core_dir(app, item)?;
        if path.exists() {
            fs::remove_dir_all(path).map_err(|error| format!("无法删除核心版本：{error}"))?;
        }
        Ok(())
    }

    pub fn latest_id(&self, app: &AppHandle) -> Option<String> {
        let bundled_version = bundled_dsh_version(app);
        self.catalog
            .iter()
            .find(|item| item.assets.contains_key(current_platform()))
            .map(|item| {
                if item.version == bundled_version {
                    BUILTIN_CORE_ID.to_string()
                } else {
                    item.id.clone()
                }
            })
    }

    pub fn active_id(&self, app: &AppHandle) -> String {
        let id = read_active_id(app);
        if id == BUILTIN_CORE_ID {
            return id;
        }
        let Some(item) = self.catalog.iter().find(|item| item.id == id) else {
            return BUILTIN_CORE_ID.to_string();
        };
        if self.core_entry(app, item).is_file() {
            id
        } else {
            BUILTIN_CORE_ID.to_string()
        }
    }

    pub fn active_version(&self, app: &AppHandle) -> String {
        let id = self.active_id(app);
        if id == BUILTIN_CORE_ID {
            return bundled_dsh_version(app);
        }
        self.catalog
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.version.clone())
            .unwrap_or_else(|| bundled_dsh_version(app))
    }

    pub fn active_root(&self, app: &AppHandle) -> PathBuf {
        let id = self.active_id(app);
        if id == BUILTIN_CORE_ID {
            return bundled_dsh_root(app);
        }
        self.catalog
            .iter()
            .find(|item| item.id == id)
            .and_then(|item| self.core_dir(app, item).ok())
            .filter(|path| path.join(CORE_ENTRY).is_file())
            .unwrap_or_else(|| bundled_dsh_root(app))
    }

    pub fn active_entry(&self, app: &AppHandle) -> PathBuf {
        self.active_root(app).join(CORE_ENTRY)
    }

    fn core_entry(&self, app: &AppHandle, item: &CoreCatalogItem) -> PathBuf {
        self.core_dir(app, item)
            .map(|path| path.join(CORE_ENTRY))
            .unwrap_or_default()
    }

    fn core_dir(&self, app: &AppHandle, item: &CoreCatalogItem) -> Result<PathBuf, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
        Ok(data_dir
            .join("dependencies")
            .join(format!("dsh-{}", item.id)))
    }

    fn write_active_id(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
        fs::create_dir_all(&data_dir)
            .map_err(|error| format!("无法创建核心版本配置目录：{error}"))?;
        let state_path = data_dir.join("active-core.json");
        let temp_path = data_dir.join(format!(".active-core-{}.json", timestamp()));
        let contents = serde_json::json!({ "active": id });
        fs::write(&temp_path, format!("{contents}\n"))
            .map_err(|error| format!("无法保存当前核心版本：{error}"))?;
        if let Err(error) = fs::rename(&temp_path, &state_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("无法切换当前核心版本：{error}"));
        }
        Ok(())
    }

    fn download_and_extract(
        &self,
        asset: &CoreAsset,
        archive_path: &Path,
        staging_dir: &Path,
        item: &CoreCatalogItem,
    ) -> Result<(), String> {
        let response = reqwest::blocking::Client::builder()
            .user_agent("deepseek-harness-desktop")
            .build()
            .map_err(|error| format!("无法创建核心下载客户端：{error}"))?
            .get(&asset.url)
            .send()
            .map_err(|error| format!("核心版本下载失败：{error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "核心版本下载失败，HTTP 状态：{}",
                response.status()
            ));
        }

        let mut response = response;
        let mut archive = File::create(archive_path)
            .map_err(|error| format!("无法创建核心下载临时文件：{error}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = response
                .read(&mut buffer)
                .map_err(|error| format!("核心版本下载中断：{error}"))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
            archive
                .write_all(&buffer[..count])
                .map_err(|error| format!("无法写入核心下载文件：{error}"))?;
        }
        archive
            .sync_all()
            .map_err(|error| format!("无法保存核心下载文件：{error}"))?;
        let digest = format!("{:x}", hasher.finalize());
        if digest != asset.sha256.to_ascii_lowercase() {
            return Err(format!(
                "核心版本校验失败：{} 的 SHA-256 不匹配",
                item.version
            ));
        }

        fs::create_dir_all(staging_dir)
            .map_err(|error| format!("无法创建核心解压目录：{error}"))?;
        let archive_file =
            File::open(archive_path).map_err(|error| format!("无法打开核心下载文件：{error}"))?;
        let mut zip = zip::ZipArchive::new(archive_file)
            .map_err(|error| format!("核心压缩包无法读取：{error}"))?;
        for index in 0..zip.len() {
            let mut entry = zip
                .by_index(index)
                .map_err(|error| format!("核心压缩包条目无法读取：{error}"))?;
            let relative = entry
                .enclosed_name()
                .ok_or_else(|| "核心压缩包包含不安全路径".to_string())?
                .to_owned();
            let destination = staging_dir.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&destination)
                    .map_err(|error| format!("无法创建核心目录：{error}"))?;
                continue;
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("无法创建核心文件目录：{error}"))?;
            }
            let mut output =
                File::create(&destination).map_err(|error| format!("无法写入核心文件：{error}"))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|error| format!("无法解压核心文件：{error}"))?;
        }
        let root =
            find_core_root(staging_dir).ok_or_else(|| "核心压缩包中找不到 dsh 入口".to_string())?;
        let package_path = root.join("node_modules/@deepseek-ai/dsh/package.json");
        let package = fs::read_to_string(&package_path)
            .map_err(|error| format!("核心 package.json 不可读：{error}"))?;
        let package_version = serde_json::from_str::<serde_json::Value>(&package)
            .ok()
            .and_then(|value| {
                value
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        if package_version != item.version {
            return Err(format!(
                "核心版本校验失败：期望 {}，实际 {}",
                item.version, package_version
            ));
        }
        Ok(())
    }
}

pub fn active_dsh_root(app: &AppHandle) -> PathBuf {
    CoreManager::default().active_root(app)
}

pub fn active_dsh_entry(app: &AppHandle) -> PathBuf {
    CoreManager::default().active_entry(app)
}

fn read_active_id(app: &AppHandle) -> String {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return BUILTIN_CORE_ID.to_string();
    };
    fs::read_to_string(data_dir.join("active-core.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|value| {
            value
                .get("active")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| BUILTIN_CORE_ID.to_string())
}

fn find_core_root(staging_dir: &Path) -> Option<PathBuf> {
    if staging_dir.join(CORE_ENTRY).is_file() {
        return Some(staging_dir.to_path_buf());
    }
    fs::read_dir(staging_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.join(CORE_ENTRY).is_file())
}

fn timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

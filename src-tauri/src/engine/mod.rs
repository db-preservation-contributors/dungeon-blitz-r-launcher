pub mod air;
pub mod binary;
pub mod integrity;
pub mod loader_swf;
pub mod projector;

use std::path::PathBuf;

#[derive(Clone, Debug, Default)]
pub struct Launch {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

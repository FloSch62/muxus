//! Spawning from code that may run outside the runtime, such as a finalizer on the JavaScript
//! thread.

/// Run `work` on the addon's runtime.
#[cfg(not(test))]
pub fn spawn(work: impl Future<Output = ()> + Send + 'static) {
    napi::bindgen_prelude::spawn(work);
}

/// Unit tests have no Node host; they run on the test's own runtime when there is one.
#[cfg(test)]
pub fn spawn(work: impl Future<Output = ()> + Send + 'static) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(work);
    }
}

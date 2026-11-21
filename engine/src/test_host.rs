//! Unit tests link as a program without a Node host. The napi crate still refers to these
//! N-API functions from paths the tests never take, so they only have to exist.

macro_rules! absent {
    ($($name:ident),* $(,)?) => {
        $(
            #[unsafe(no_mangle)]
            pub extern "C" fn $name() -> i32 {
                unreachable!("N-API is not available in unit tests")
            }
        )*
    };
}

absent!(
    napi_create_error,
    napi_create_string_utf8,
    napi_delete_reference,
    napi_get_and_clear_last_exception,
    napi_get_named_property,
    napi_get_reference_value,
    napi_is_error,
    napi_is_exception_pending,
    napi_reference_unref,
    napi_set_named_property,
    napi_throw,
);

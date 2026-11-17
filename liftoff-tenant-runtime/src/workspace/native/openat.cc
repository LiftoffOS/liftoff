// R5 Fix 1 (SE-R5-003): openat() native binding for atomic write-path TOCTOU closure.
//
// Opens a parent directory with O_DIRECTORY | O_NOFOLLOW, then openat(dirfd, basename, flags).
// This is kernel-atomic against symlink swap on the final path component —
// the parent-then-openat sequence happens with no userspace race window.
//
// Returns the file descriptor on success. Caller is responsible for close().

#include <napi.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

// openatNoFollow(dirPath: string, basename: string, flags: number): number
// Throws on error with errno-derived message (ELOOP, ENOENT, EACCES, etc.)
Napi::Value OpenatNoFollow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "expected (dirPath: string, basename: string, flags: number)").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string dirPath = info[0].As<Napi::String>().Utf8Value();
  std::string basename = info[1].As<Napi::String>().Utf8Value();
  int flags = info[2].As<Napi::Number>().Int32Value();

  // Step 1: open the parent directory with O_DIRECTORY | O_NOFOLLOW.
  // If any component in dirPath is a symlink escaping the chain, this succeeds
  // only if the symlink itself is not the final dirPath component. The caller
  // is expected to have pre-validated dirPath via walkParentChainNoSymlinkEscape.
  int dirfd = open(dirPath.c_str(), O_DIRECTORY | O_NOFOLLOW | O_RDONLY);
  if (dirfd < 0) {
    int err = errno;
    std::string msg = "open parent failed: " + std::string(strerror(err));
    Napi::Error e = Napi::Error::New(env, msg);
    e.Set("code", Napi::String::New(env, err == ELOOP ? "ELOOP" :
                                          err == ENOENT ? "ENOENT" :
                                          err == EACCES ? "EACCES" :
                                          err == ENOTDIR ? "ENOTDIR" : "UNKNOWN"));
    e.Set("errno", Napi::Number::New(env, err));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }

  // Step 2: openat(dirfd, basename, flags | O_NOFOLLOW) — atomic with respect to
  // any racing symlink swap on the basename. Must include O_NOFOLLOW in flags
  // to reject symlinks at the final component.
  int fd = openat(dirfd, basename.c_str(), flags | O_NOFOLLOW, 0600);
  int openat_err = errno;
  close(dirfd);

  if (fd < 0) {
    std::string msg = "openat failed: " + std::string(strerror(openat_err));
    Napi::Error e = Napi::Error::New(env, msg);
    e.Set("code", Napi::String::New(env, openat_err == ELOOP ? "ELOOP" :
                                            openat_err == ENOENT ? "ENOENT" :
                                            openat_err == EACCES ? "EACCES" :
                                            openat_err == EEXIST ? "EEXIST" : "UNKNOWN"));
    e.Set("errno", Napi::Number::New(env, openat_err));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }

  return Napi::Number::New(env, fd);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("openatNoFollow", Napi::Function::New(env, OpenatNoFollow));
  // Export fcntl flag constants for JS callers
  exports.Set("O_RDONLY", Napi::Number::New(env, O_RDONLY));
  exports.Set("O_WRONLY", Napi::Number::New(env, O_WRONLY));
  exports.Set("O_RDWR", Napi::Number::New(env, O_RDWR));
  exports.Set("O_CREAT", Napi::Number::New(env, O_CREAT));
  exports.Set("O_EXCL", Napi::Number::New(env, O_EXCL));
  exports.Set("O_NOFOLLOW", Napi::Number::New(env, O_NOFOLLOW));
  exports.Set("O_DIRECTORY", Napi::Number::New(env, O_DIRECTORY));
  exports.Set("O_TRUNC", Napi::Number::New(env, O_TRUNC));
  return exports;
}

NODE_API_MODULE(openat, Init)

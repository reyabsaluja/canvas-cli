#!/usr/bin/env bash
# canvas-cli installer
#
#   curl -fsSL https://raw.githubusercontent.com/reyabsaluja/canvas-cli/main/install.sh | bash
#
# Installs a standalone canvas-cli binary (no Node.js needed) from the latest
# GitHub release into ~/.local/bin. Re-run it to update.
#
# Options (environment variables):
#   CANVAS_CLI_VERSION      install a specific version, e.g. 0.2.0 (default: latest)
#   CANVAS_CLI_INSTALL_DIR  install directory (default: ~/.local/bin)
#   CANVAS_CLI_DOWNLOAD_URL where to fetch binaries and SHA256SUMS (default: GitHub releases)
#
# A version can also be passed as an argument:
#   curl -fsSL .../install.sh | bash -s -- 0.2.0

set -euo pipefail

REPO="reyabsaluja/canvas-cli"
BIN_NAME="canvas-cli"

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" RESET=""
fi

info() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "${YELLOW}warning:${RESET} $*" >&2; }
die() {
  printf '%s\n' "${RED}error:${RESET} $*" >&2
  exit 1
}

# Wrapping everything in main() means a truncated download (curl | bash cut
# off mid-stream) runs nothing rather than half a script.
main() {
  local version="${1:-${CANVAS_CLI_VERSION:-latest}}"
  version="${version#v}"
  local install_dir="${CANVAS_CLI_INSTALL_DIR:-$HOME/.local/bin}"

  local target
  target="$(detect_target)"

  local base_url
  if [ -n "${CANVAS_CLI_DOWNLOAD_URL:-}" ]; then
    base_url="${CANVAS_CLI_DOWNLOAD_URL%/}"
  elif [ "$version" = "latest" ]; then
    base_url="https://github.com/${REPO}/releases/latest/download"
  else
    base_url="https://github.com/${REPO}/releases/download/v${version}"
  fi

  local asset="${BIN_NAME}-${target}"
  info "${BOLD}Installing canvas-cli${RESET} ${DIM}(${version}, ${target})${RESET}"

  # Global, not local: the EXIT trap runs after main() has returned.
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  download "${base_url}/${asset}" "${tmp_dir}/${asset}" ||
    die "could not download ${asset} (version ${version}).
  Check that the version exists: https://github.com/${REPO}/releases
  Or install with npm instead: npm install -g @reyabsaluja/canvas-cli"
  download "${base_url}/SHA256SUMS" "${tmp_dir}/SHA256SUMS" ||
    die "could not download SHA256SUMS for version ${version}"

  verify_checksum "$tmp_dir" "$asset"

  chmod +x "${tmp_dir}/${asset}"
  local installed_version
  installed_version="$("${tmp_dir}/${asset}" --version 2>/dev/null)" ||
    die "the downloaded binary does not run on this system (${target})"

  mkdir -p "$install_dir"
  # Move into place atomically so a running canvas-cli is never half-overwritten.
  mv -f "${tmp_dir}/${asset}" "${install_dir}/${BIN_NAME}.tmp.$$"
  mv -f "${install_dir}/${BIN_NAME}.tmp.$$" "${install_dir}/${BIN_NAME}"

  info "${GREEN}✓${RESET} canvas-cli ${installed_version} installed to ${install_dir}/${BIN_NAME}"

  check_path "$install_dir"

  info ""
  info "Next: run ${BOLD}canvas-cli${RESET} to sign in to Canvas and get started."
}

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    MINGW* | MSYS* | CYGWIN*)
      die "Windows is not supported by this installer. Use npm instead:
  npm install -g @reyabsaluja/canvas-cli"
      ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) die "unsupported CPU architecture: $(uname -m)" ;;
  esac

  # An x64 shell running under Rosetta on Apple Silicon should still get the native build.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi

  # Alpine and other musl-based distros need the musl build.
  if [ "$os" = "linux" ] && is_musl; then
    printf '%s' "${os}-${arch}-musl"
  else
    printf '%s' "${os}-${arch}"
  fi
}

is_musl() {
  if ls /lib/ld-musl-* >/dev/null 2>&1; then
    return 0
  fi
  ldd --version 2>&1 | grep -qi musl
}

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    die "curl or wget is required"
  fi
}

verify_checksum() {
  local dir="$1" asset="$2" expected actual
  expected="$(awk -v f="$asset" '$2 == f { print $1 }' "${dir}/SHA256SUMS")"
  [ -n "$expected" ] || die "no checksum listed for ${asset}"

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${dir}/${asset}" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${dir}/${asset}" | awk '{ print $1 }')"
  else
    warn "no sha256 tool found; skipping checksum verification"
    return 0
  fi

  [ "$expected" = "$actual" ] || die "checksum mismatch for ${asset}; the download may be corrupted. Try again."
}

check_path() {
  local install_dir="$1"

  case ":${PATH}:" in
    *":${install_dir}:"*)
      # On PATH. Warn if another canvas-cli (e.g. an npm global) wins over this one.
      local resolved
      resolved="$(command -v "$BIN_NAME" 2>/dev/null || true)"
      if [ -n "$resolved" ] && [ "$resolved" != "${install_dir}/${BIN_NAME}" ]; then
        warn "another canvas-cli at ${resolved} comes first on your PATH.
  Remove it (npm uninstall -g @reyabsaluja/canvas-cli) or put ${install_dir} earlier in PATH."
      fi
      return 0
      ;;
  esac

  local rc_file line
  case "$(basename "${SHELL:-}")" in
    zsh)
      rc_file="~/.zshrc"
      line="export PATH=\"${install_dir}:\$PATH\""
      ;;
    bash)
      rc_file="~/.bashrc"
      line="export PATH=\"${install_dir}:\$PATH\""
      ;;
    fish)
      rc_file="~/.config/fish/config.fish"
      line="fish_add_path ${install_dir}"
      ;;
    *)
      info ""
      warn "${install_dir} is not on your PATH. Add it in your shell's startup file."
      return 0
      ;;
  esac

  info ""
  warn "${install_dir} is not on your PATH. Add it by running:"
  info ""
  info "  echo '${line}' >> ${rc_file} && source ${rc_file}"
}

main "$@"

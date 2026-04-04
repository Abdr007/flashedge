class FlashTerminal < Formula
  desc "Professional CLI trading terminal for Flash Trade on Solana"
  homepage "https://github.com/Abdr007/bolt-terminal"
  url "https://github.com/Abdr007/bolt-terminal.git", branch: "main"
  version "1.0.0"
  license "MIT"

  depends_on "node@24"

  def install
    system "npm", "ci"
    system "npm", "run", "build"
    libexec.install Dir["*"]
    bin.install_symlink libexec/"dist/index.js" => "flash"
  end

  test do
    assert_match "Flash Terminal", shell_output("#{bin}/flash --version")
  end
end

---
title: 使用 linuxbres 解决 vscode 无法 ssh 连接旧版本服务器的问题
date: 2026-06-25
tags: [debug]
summary: 解决 vscode 无法 ssh 连接旧版本服务器的问题
---

方法来源：​如何通过homebrew解决vscode无法连接老版本linux - 🛠工具与编程 / 💻编程 - 始徒Beginner
下载 linuxbrew

下载 homebrew 到 /home/user/homebrew/ 下
## 1. 创建一个 homebrew 目录
```bash
mkdir -p ~/homebrew
```

## 2. 下载并解压 Homebrew
```bash
curl -L https://github.com/Homebrew/brew/tarball/main \
  | tar -xz --strip-components=1 -C ~/homebrew
```
配置 linuxbrew
```bash
echo 'eval "$(~/homebrew/bin/brew shellenv)"' >> ~/.bashrc
eval "$(~/homebrew/bin/brew shellenv)"
```
检查是否安装成功
```bash
brew --version
```
安装基础依赖
```bash
brew doctor
```
让 vscode ssh 使用 linuxbrew 的 glib

写入 vscode 读取的环境变量

确认路径
```bash
brew --prefix glibc
```
## 假设路径是：/home/user/homebrew/
安装 glibc + patchelf
```bash
brew install glibc patchelf
```
写入 vscode 需要的环境变量
```bash
nano ~/.ssh/environment
```
在配置中写入：
```text
VSCODE_SERVER_CUSTOM_GLIBC_PATH=/home/user/homebrew/opt/glibc/lib
VSCODE_SERVER_PATCHELF_PATH=/home/user/homebrew/bin/patchelf
VSCODE_SERVER_CUSTOM_GLIBC_LINKER=/home/user/homebrew/opt/glibc/lib/ld-linux-x86-64.so.2
```

## 注意这里的路径与前面保持一致
开启 ssh 读取环境变量

这里需要用到 sudo 权限，打开：
```bash
sudo nano /etc/ssh/sshd_config
```
设置 PermitUserEnvironment 为：
```text
PermitUserEnvironment yes
```
重启 ssh 服务：
```bash
sudo systemctl restart sshd
```
一些检查
```bash
sshd -T | grep permituserenvironment
# 期望输入为 PermitUserEnvironment yes
```

```bash
ls -l ~/.ssh/environment
#期望输出为 -rw------- 1 user data 222 4月 27 11:23 /home/user/.ssh/environment
```
如果这里输出为：
```text
-rw-r--r-- 1 user data 222 4月 27 11:23 /home/user/.ssh/environment
```
会导致文件权限不足，vscode连接时会直接忽略这个文件，导致我们的配置失败，因此需要修复权限：
```bash
chmod 600 ~/.ssh/environment
```
最后检查：
```bash
cat ~/.ssh/environment

#期望输出为：
VSCODE_SERVER_CUSTOM_GLIBC_PATH=/home/user/homebrew/opt/glibc/lib
VSCODE_SERVER_PATCHELF_PATH=/home/user/homebrew/bin/patchelf
VSCODE_SERVER_CUSTOM_GLIBC_LINKER=/home/user/homebrew/opt/glibc/lib/ld-linux-x86-64.so.2
```
vscode 连接

在连接之前需要删除之前的缓存文件
```bash
rm -rf ~/.vscode-server
```

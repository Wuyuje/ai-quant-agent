/* ═══ ARK Quant Agent — Internationalization ═══ */
const I18N = {
  zh: {
    lang: '中文', dir: 'ltr',
    login: {
      title: 'ARK Quant Agent',
      subtitle: '智能合约钱包 · 纯自动交易',
      desc: '你的资金在链上合约里，安全可控',
      step1: 'TP 钱包签名登录（无需私钥）',
      step2: '一键部署你的专属合约钱包',
      step3: '转入 USDT 到合约钱包',
      step4: '开启交易 全自动帮你赚钱',
      connect: '连接 TP 钱包',
      connecting: '连接中...',
      signing: '请在 TP 钱包中确认签名...',
      verifying: '验证签名...',
      success: '登录成功',
      placeholder1: '钱包地址(0x...)',
      placeholder2: '密码',
      loginBtn: '登录',
      divider: '首次使用？',
      registerBtn: '注册新账号',
      registering: '注册中...',
      registerOk: '注册成功，已自动登录',
      loginFooter: '输入你的 BSC 钱包地址和密码',
      fee: '算力 Token（仅盈利时收取）',
      noWallet: '请在 TokenPocket 浏览器中打开，或安装 TP 钱包'
    },
    header: { version: 'v3.0 智能合约模式', logout: '退出' },
    status: {
      vault: 'Vault', deployed: '已部署', undeployed: '未部署',
      trading: '交易', running: '运行中', off: '未启用',
      strategy: '策略', fee: '算力 Token', users: '用户'
    },
    deploy: {
      title: '部署你的智能合约钱包',
      desc: '每个用户拥有独立的合约钱包，资金完全隔离，平台只有交易执行权限',
      s1t: '登录注册', s1d: '钱包地址 + 密码',
      s2t: '部署合约', s2d: '一键部署 Vault',
      s3t: '转入资金', s3d: 'USDT / BNB',
      s4t: '开启交易', s4d: '全自动运行',
      btn: '部署我的合约钱包',
      deploying: '部署中（需要 TP 确认）...',
      confirm: '正在部署 Vault，请在 TP 钱包中确认交易...',
      success: 'Vault 部署成功！', failed: '部署失败'
    },
    ctrl: {
      start: '开启交易', stop: '停止交易', revoke: '紧急撤销权限',
      settings: '设置', refresh: '刷新',
      revokeConfirm: '⚠️ 确认紧急撤销交易权限？\n\n这将：\n1. 立即停止机器人操作你的资金\n2. 平台无法再执行任何交易\n3. 你的资金仍然在合约里，可以随时提取\n\n确认？',
      revoking: '正在撤销权限...', revoked: '已撤销，平台无法再操作你的资金'
    },
    settings: {
      title: '交易设置', strategy: '交易策略',
      conservative: '保守 (低风险)', balanced: '平衡 (推荐)', aggressive: '激进 (高收益)',
      maxSingle: '单笔最大交易 (USDT)', dailyLimit: '每日交易限额 (USDT)',
      save: '保存', cancel: '取消', saved: '设置已保存'
    },
    dash: {
      balance: 'Vault 余额', loading: '加载中...',
      positions: '当前持仓', empty: '空仓',
      running: '运行中', paused: '已暂停', engineOff: '引擎未启动',
      totalPnl: '累计盈亏', pnlDetail: '累计盈亏 | 交易: {0} 次',
      risk: '风控状态', riskNormal: '正常', riskDetail: '单笔限额: $50,000 | 日限额: $200,000',
      posDetail: '持仓详情', recentTrades: '最近交易', noTrades: '暂无交易'
    },
    withdraw: {
      title: '提现', usdt: '提取全部 USDT', bnb: '提取全部 BNB',
      desc: '提取后资金直接回到你的 TP 钱包',
      usdtConfirm: '确认提取所有 USDT 到 TP 钱包？',
      bnbConfirm: '确认提取所有 BNB 到 TP 钱包？',
      processing: '提现中...', usdtOk: 'USDT 已提取到 TP 钱包', bnbOk: 'BNB 已提取到 TP 钱包'
    },
    footer: 'ARK Quant Agent v3.0 · 智能合约钱包模式 · 资金安全上链'
  },

  en: {
    lang: 'EN', dir: 'ltr',
    login: {
      title: 'ARK Quant Agent',
      subtitle: 'Smart Contract Wallet · Fully Automated Trading',
      desc: 'Your funds are in on-chain contracts, safe and controllable',
      step1: 'Sign in with TP Wallet (no private key needed)',
      step2: 'Deploy your personal contract wallet',
      step3: 'Transfer USDT to the contract wallet',
      step4: 'Start trading — fully automated',
      connect: 'Connect TP Wallet',
      connecting: 'Connecting...',
      signing: 'Please confirm signature in TP Wallet...',
      verifying: 'Verifying signature...',
      success: 'Login successful',
      placeholder1: 'Wallet address (0x...)',
      placeholder2: 'Password',
      loginBtn: 'Login',
      divider: 'New user?',
      registerBtn: 'Register',
      registering: 'Registering...',
      registerOk: 'Registered & logged in',
      loginFooter: 'Enter your BSC wallet address and password',
      fee: 'Platform fee 20% (only on profits)',
      noWallet: 'Please open in TokenPocket browser or install TP Wallet'
    },
    header: { version: 'v3.0 Smart Contract Mode', logout: 'Logout' },
    status: {
      vault: 'Vault', deployed: 'Deployed', undeployed: 'Not Deployed',
      trading: 'Trading', running: 'Running', off: 'Off',
      strategy: 'Strategy', fee: 'Fee', users: 'Users'
    },
    deploy: {
      title: 'Deploy Your Smart Contract Wallet',
      desc: 'Each user has an isolated contract wallet. Funds are fully segregated — the platform only has trade execution permission.',
      s1t: 'Sign In', s1d: 'Wallet address + password',
      s2t: 'Deploy', s2d: 'One-click Vault deploy',
      s3t: 'Fund Wallet', s3d: 'USDT / BNB',
      s4t: 'Start Trading', s4d: 'Fully automated',
      btn: 'Deploy My Contract Wallet',
      deploying: 'Deploying (TP confirmation needed)...',
      confirm: 'Deploying Vault — please confirm in TP Wallet...',
      success: 'Vault deployed!', failed: 'Deployment failed'
    },
    ctrl: {
      start: 'Start Trading', stop: 'Stop Trading', revoke: 'Emergency Revoke',
      settings: 'Settings', refresh: 'Refresh',
      revokeConfirm: '⚠️ Confirm emergency revoke?\n\nThis will:\n1. Immediately stop the bot from operating your funds\n2. Platform can no longer execute any trades\n3. Your funds remain in the contract and can be withdrawn anytime\n\nConfirm?',
      revoking: 'Revoking access...', revoked: 'Access revoked — platform can no longer operate your funds'
    },
    settings: {
      title: 'Trading Settings', strategy: 'Strategy',
      conservative: 'Conservative (Low Risk)', balanced: 'Balanced (Recommended)', aggressive: 'Aggressive (High Return)',
      maxSingle: 'Max Single Trade (USDT)', dailyLimit: 'Daily Limit (USDT)',
      save: 'Save', cancel: 'Cancel', saved: 'Settings saved'
    },
    dash: {
      balance: 'Vault Balance', loading: 'Loading...',
      positions: 'Open Positions', empty: 'No positions',
      running: 'Running', paused: 'Paused', engineOff: 'Engine Off',
      totalPnl: 'Total P&L', pnlDetail: 'Total P&L | {0} trades',
      risk: 'Risk Control', riskNormal: 'Normal', riskDetail: 'Per-trade: $50,000 | Daily: $200,000',
      posDetail: 'Position Details', recentTrades: 'Recent Trades', noTrades: 'No trades yet'
    },
    withdraw: {
      title: 'Withdraw', usdt: 'Withdraw All USDT', bnb: 'Withdraw All BNB',
      desc: 'Funds go directly back to your TP Wallet',
      usdtConfirm: 'Withdraw all USDT to TP Wallet?',
      bnbConfirm: 'Withdraw all BNB to TP Wallet?',
      processing: 'Withdrawing...', usdtOk: 'USDT withdrawn to TP Wallet', bnbOk: 'BNB withdrawn to TP Wallet'
    },
    footer: 'ARK Quant Agent v3.0 · Smart Contract Wallet · On-chain Security'
  },

  ja: {
    lang: '日本語', dir: 'ltr',
    login: {
      title: 'ARK Quant Agent',
      subtitle: 'スマートコントラクトウォレット · 完全自動取引',
      desc: '資金はオンチェーンコントラクトにあり、安全でコントロール可能',
      step1: 'TPウォレットでサインイン（秘密鍵不要）',
      step2: '専用コントラクトウォレットをワンクリックでデプロイ',
      step3: 'USDTをコントラクトウォレットに転送',
      step4: '取引を開始 — 完全自動',
      connect: 'TPウォレットを接続',
      connecting: '接続中...',
      signing: 'TPウォレットで署名を確認してください...',
      verifying: '署名を確認中...',
      success: 'ログイン成功',
      placeholder1: 'ウォレットアドレス (0x...)',
      placeholder2: 'パスワード',
      loginBtn: 'ログイン',
      divider: '初めての方？',
      registerBtn: '新規登録',
      registering: '登録中...',
      registerOk: '登録完了、自動ログインしました',
      loginFooter: 'BSCウォレットアドレスとパスワードを入力',
      fee: 'プラットフォーム手数料 20%（利益時のみ）',
      noWallet: 'TokenPocketブラウザで開くか、TPウォレットをインストールしてください'
    },
    header: { version: 'v3.0 スマートコントラクトモード', logout: 'ログアウト' },
    status: {
      vault: 'Vault', deployed: 'デプロイ済み', undeployed: '未デプロイ',
      trading: '取引', running: '稼働中', off: 'オフ',
      strategy: '戦略', fee: '手数料', users: 'ユーザー'
    },
    deploy: {
      title: 'スマートコントラクトウォレットをデプロイ',
      desc: 'ユーザーごとに独立したコントラクトウォレット。資金は完全に分離され、プラットフォームは取引実行のみ可能。',
      s1t: 'サインイン', s1d: 'ウォレットアドレス + パスワード',
      s2t: 'デプロイ', s2d: 'ワンクリックVaultデプロイ',
      s3t: '入金', s3d: 'USDT / BNB',
      s4t: '取引開始', s4d: '完全自動',
      btn: 'コントラクトウォレットをデプロイ',
      deploying: 'デプロイ中（TP確認が必要）...',
      confirm: 'Vaultをデプロイ中 — TPウォレットで確認してください...',
      success: 'Vaultデプロイ完了！', failed: 'デプロイ失敗'
    },
    ctrl: {
      start: '取引開始', stop: '取引停止', revoke: '緊急権限取り消し',
      settings: '設定', refresh: '更新',
      revokeConfirm: '⚠️ 緊急権限取り消しを確認？\n\nこれにより：\n1. ボットの資金操作が直ちに停止\n2. プラットフォームは取引不可に\n3. 資金はコントラクト内にあり、いつでも引き出せます\n\n確認？',
      revoking: '権限を取消中...', revoked: '権限取消済み — プラットフォームは資金操作不可'
    },
    settings: {
      title: '取引設定', strategy: '戦略',
      conservative: '保守的（低リスク）', balanced: 'バランス（推奨）', aggressive: '積極的（高リターン）',
      maxSingle: '1回あたり最大取引 (USDT)', dailyLimit: '1日制限 (USDT)',
      save: '保存', cancel: 'キャンセル', saved: '設定保存済み'
    },
    dash: {
      balance: 'Vault残高', loading: '読み込み中...',
      positions: 'ポジション', empty: 'ポジションなし',
      running: '稼働中', paused: '一時停止', engineOff: 'エンジン停止',
      totalPnl: '累計損益', pnlDetail: '累計損益 | {0}件の取引',
      risk: 'リスク管理', riskNormal: '正常', riskDetail: '1回: $50,000 | 1日: $200,000',
      posDetail: 'ポジション詳細', recentTrades: '最近の取引', noTrades: '取引なし'
    },
    withdraw: {
      title: '出金', usdt: '全USDT出金', bnb: '全BNB出金',
      desc: '出金後、資金はTPウォレットに戻ります',
      usdtConfirm: '全USDTをTPウォレットに出金？',
      bnbConfirm: '全BNBをTPウォレットに出金？',
      processing: '出金中...', usdtOk: 'USDT出金完了', bnbOk: 'BNB出金完了'
    },
    footer: 'ARK Quant Agent v3.0 · スマートコントラクトウォレット · オンチェーンセキュリティ'
  },

  ko: {
    lang: '한국어', dir: 'ltr',
    login: {
      title: 'ARK Quant Agent',
      subtitle: '스마트 컨트랙트 월렛 · 완전 자동 거래',
      desc: '자금이 온체인 컨트랙트에 있어 안전하고 제어 가능',
      step1: 'TP 월렛으로 로그인 (개인키 불필요)',
      step2: '전용 컨트랙트 월렛 원클릭 배포',
      step3: 'USDT를 컨트랙트 월렛으로 전송',
      step4: '거래 시작 — 완전 자동',
      connect: 'TP 월렛 연결',
      connecting: '연결 중...',
      signing: 'TP 월렛에서 서명을 확인하세요...',
      verifying: '서명 확인 중...',
      success: '로그인 성공',
      placeholder1: '지갑 주소 (0x...)',
      placeholder2: '비밀번호',
      loginBtn: '로그인',
      divider: '처음이신가요?',
      registerBtn: '새 계정 등록',
      registering: '등록 중...',
      registerOk: '등록 완료, 자동 로그인됨',
      loginFooter: 'BSC 지갑 주소와 비밀번호를 입력하세요',
      fee: '플랫폼 수수료 20% (수익 시에만)',
      noWallet: 'TokenPocket 브라우저에서 열거나 TP 월렛을 설치하세요'
    },
    header: { version: 'v3.0 스마트 컨트랙트 모드', logout: '로그아웃' },
    status: {
      vault: 'Vault', deployed: '배포됨', undeployed: '미배포',
      trading: '거래', running: '실행 중', off: '중지',
      strategy: '전략', fee: '수수료', users: '사용자'
    },
    deploy: {
      title: '스마트 컨트랙트 월렛 배포',
      desc: '각 사용자마다 독립된 컨트랙트 월렛. 자금이 완전히 분리되며 플랫폼은 거래 실행 권한만 가집니다.',
      s1t: '로그인', s1d: '지갑 주소 + 비밀번호',
      s2t: '배포', s2d: '원클릭 Vault 배포',
      s3t: '입금', s3d: 'USDT / BNB',
      s4t: '거래 시작', s4d: '완전 자동',
      btn: '컨트랙트 월렛 배포',
      deploying: '배포 중 (TP 확인 필요)...',
      confirm: 'Vault 배포 중 — TP 월렛에서 확인하세요...',
      success: 'Vault 배포 완료!', failed: '배포 실패'
    },
    ctrl: {
      start: '거래 시작', stop: '거래 중지', revoke: '긴급 권한 취소',
      settings: '설정', refresh: '새로고침',
      revokeConfirm: '⚠️ 긴급 권한 취소 확인?\n\n이로 인해:\n1. 봇의 자금 운영이 즉시 중지\n2. 플랫폼은 더 이상 거래 불가\n3. 자금은 컨트랙트에 있으며 언제든 인출 가능\n\n확인?',
      revoking: '권한 취소 중...', revoked: '권한 취소됨 — 플랫폼은 자금 운영 불가'
    },
    settings: {
      title: '거래 설정', strategy: '전략',
      conservative: '보수적 (저위험)', balanced: '균형 (추천)', aggressive: '공격적 (고수익)',
      maxSingle: '1회 최대 거래 (USDT)', dailyLimit: '일일 한도 (USDT)',
      save: '저장', cancel: '취소', saved: '설정 저장됨'
    },
    dash: {
      balance: 'Vault 잔액', loading: '로딩...',
      positions: '포지션', empty: '포지션 없음',
      running: '실행 중', paused: '일시정지', engineOff: '엔진 중지',
      totalPnl: '누적 손익', pnlDetail: '누적 손익 | {0}건 거래',
      risk: '리스크 관리', riskNormal: '정상', riskDetail: '1회: $50,000 | 1일: $200,000',
      posDetail: '포지션 상세', recentTrades: '최근 거래', noTrades: '거래 없음'
    },
    withdraw: {
      title: '출금', usdt: '전체 USDT 출금', bnb: '전체 BNB 출금',
      desc: '출금 후 자금이 TP 월렛으로 돌아갑니다',
      usdtConfirm: '전체 USDT를 TP 월렛으로 출금?',
      bnbConfirm: '전체 BNB를 TP 월렛으로 출금?',
      processing: '출금 중...', usdtOk: 'USDT 출금 완료', bnbOk: 'BNB 출금 완료'
    },
    footer: 'ARK Quant Agent v3.0 · 스마트 컨트랙트 월렛 · 온체인 보안'
  },

  vi: {
    lang: 'Tiếng Việt', dir: 'ltr',
    login: {
      title: 'ARK Quant Agent',
      subtitle: 'Ví Thông Minh Hợp Đồng · Giao Dịch Tự Động',
      desc: 'Quỹ của bạn nằm trên hợp đồng on-chain, an toàn và kiểm soát được',
      step1: 'Đăng nhập bằng TP Wallet (không cần khóa riêng)',
      step2: 'Triển khai ví hợp đồng cá nhân',
      step3: 'Chuyển USDT vào ví hợp đồng',
      step4: 'Bắt đầu giao dịch — hoàn toàn tự động',
      connect: 'Kết nối TP Wallet',
      connecting: 'Đang kết nối...',
      signing: 'Vui lòng xác nhận chữ ký trong TP Wallet...',
      verifying: 'Xác minh chữ ký...',
      success: 'Đăng nhập thành công',
      placeholder1: 'Địa chỉ ví (0x...)',
      placeholder2: 'Mật khẩu',
      loginBtn: 'Đăng nhập',
      divider: 'Lần đầu sử dụng?',
      registerBtn: 'Đăng ký tài khoản',
      registering: 'Đang đăng ký...',
      registerOk: 'Đăng ký thành công, đã tự động đăng nhập',
      loginFooter: 'Nhập địa chỉ ví BSC và mật khẩu',
      fee: 'Phí nền tảng 20% (chỉ khi có lợi nhuận)',
      noWallet: 'Vui lòng mở trong trình duyệt TokenPocket hoặc cài đặt TP Wallet'
    },
    header: { version: 'v3.0 Chế Độ Hợp Đồng', logout: 'Đăng xuất' },
    status: {
      vault: 'Vault', deployed: 'Đã triển khai', undeployed: 'Chưa triển khai',
      trading: 'Giao dịch', running: 'Đang chạy', off: 'Tắt',
      strategy: 'Chiến lược', fee: 'Phí', users: 'Người dùng'
    },
    deploy: {
      title: 'Triển Khai Ví Hợp Đồng Thông Minh',
      desc: 'Mỗi người dùng có ví hợp đồng riêng biệt, quỹ được tách biệt hoàn toàn — nền tảng chỉ có quyền thực hiện giao dịch.',
      s1t: 'Đăng nhập', s1d: 'Địa chỉ ví + mật khẩu',
      s2t: 'Triển khai', s2d: 'Triển khai Vault',
      s3t: 'Nạp tiền', s3d: 'USDT / BNB',
      s4t: 'Giao dịch', s4d: 'Tự động hoàn toàn',
      btn: 'Triển Khai Ví Hợp Đồng',
      deploying: 'Đang triển khai (cần xác nhận TP)...',
      confirm: 'Đang triển khai Vault — vui lòng xác nhận trong TP Wallet...',
      success: 'Triển khai Vault thành công!', failed: 'Triển khai thất bại'
    },
    ctrl: {
      start: 'Bắt đầu giao dịch', stop: 'Dừng giao dịch', revoke: 'Thu hồi khẩn cấp',
      settings: 'Cài đặt', refresh: 'Làm mới',
      revokeConfirm: '⚠️ Xác nhận thu hồi quyền khẩn cấp?\n\nĐiều này sẽ:\n1. Ngay lập tức dừng bot thao tác quỹ\n2. Nền tảng không thể thực hiện giao dịch\n3. Quỹ vẫn trong hợp đồng, có thể rút bất cứ lúc nào\n\nXác nhận?',
      revoking: 'Đang thu hồi quyền...', revoked: 'Đã thu hồi — nền tảng không thể thao tác quỹ'
    },
    settings: {
      title: 'Cài Đặt Giao Dịch', strategy: 'Chiến lược',
      conservative: 'Thận trọng (Rủi ro thấp)', balanced: 'Cân bằng (Khuyến nghị)', aggressive: 'Tích cực (Lợi nhuận cao)',
      maxSingle: 'Giao dịch tối đa/lần (USDT)', dailyLimit: 'Hạn mức ngày (USDT)',
      save: 'Lưu', cancel: 'Hủy', saved: 'Đã lưu cài đặt'
    },
    dash: {
      balance: 'Số dư Vault', loading: 'Đang tải...',
      positions: 'Vị thế', empty: 'Không có vị thế',
      running: 'Đang chạy', paused: 'Tạm dừng', engineOff: 'Engine tắt',
      totalPnl: 'Tổng L/N', pnlDetail: 'Tổng L/N | {0} giao dịch',
      risk: 'Quản lý rủi ro', riskNormal: 'Bình thường', riskDetail: 'Mỗi lần: $50,000 | Ngày: $200,000',
      posDetail: 'Chi tiết vị thế', recentTrades: 'Giao dịch gần đây', noTrades: 'Chưa có giao dịch'
    },
    withdraw: {
      title: 'Rút tiền', usdt: 'Rút toàn bộ USDT', bnb: 'Rút toàn bộ BNB',
      desc: 'Sau khi rút, quỹ sẽ về trực tiếp TP Wallet',
      usdtConfirm: 'Rút toàn bộ USDT vào TP Wallet?',
      bnbConfirm: 'Rút toàn bộ BNB vào TP Wallet?',
      processing: 'Đang rút...', usdtOk: 'Đã rút USDT', bnbOk: 'Đã rút BNB'
    },
    footer: 'ARK Quant Agent v3.0 · Ví Hợp Đồng Thông Minh · Bảo Mật On-chain'
  },

  ru: {
    lang: 'Русский', dir: 'ltr',
    login: {
      title: 'ARK Quant Agent',
      subtitle: 'Смарт-контракт кошелёк · Автоматическая торговля',
      desc: 'Ваши средства в on-chain контрактах, безопасно и под контролем',
      step1: 'Войти через TP Wallet (без приватного ключа)',
      step2: 'Развернуть персональный контракт кошелёк',
      step3: 'Перевести USDT в контракт кошелёк',
      step4: 'Начать торговлю — полностью автоматически',
      connect: 'Подключить TP Wallet',
      connecting: 'Подключение...',
      signing: 'Подтвердите подпись в TP Wallet...',
      verifying: 'Проверка подписи...',
      success: 'Вход выполнен',
      placeholder1: 'Адрес кошелька (0x...)',
      placeholder2: 'Пароль',
      loginBtn: 'Войти',
      divider: 'Впервые?',
      registerBtn: 'Регистрация',
      registering: 'Регистрация...',
      registerOk: 'Зарегистрировано, авто-вход выполнен',
      loginFooter: 'Введите адрес BSC кошелька и пароль',
      fee: 'Комиссия платформы 20% (только с прибыли)',
      noWallet: 'Откройте в браузере TokenPocket или установите TP Wallet'
    },
    header: { version: 'v3.0 Смарт-контракт режим', logout: 'Выход' },
    status: {
      vault: 'Vault', deployed: 'Развёрнут', undeployed: 'Не развёрнут',
      trading: 'Торговля', running: 'Активна', off: 'Выкл',
      strategy: 'Стратегия', fee: 'Комиссия', users: 'Пользователи'
    },
    deploy: {
      title: 'Развернуть Смарт-контракт Кошелёк',
      desc: 'У каждого пользователя изолированный контракт кошелёк. Средства полностью разделены — платформа имеет только право на исполнение сделок.',
      s1t: 'Вход', s1d: 'Адрес кошелька + пароль',
      s2t: 'Развернуть', s2d: 'Одноразовый деплой Vault',
      s3t: 'Пополнить', s3d: 'USDT / BNB',
      s4t: 'Торговля', s4d: 'Полностью автоматически',
      btn: 'Развернуть Контракт Кошелёк',
      deploying: 'Развёртывание (нужно подтверждение TP)...',
      confirm: 'Развёртывание Vault — подтвердите в TP Wallet...',
      success: 'Vault развёрнут!', failed: 'Ошибка развёртывания'
    },
    ctrl: {
      start: 'Начать торговлю', stop: 'Остановить', revoke: 'Экстренный отзыв',
      settings: 'Настройки', refresh: 'Обновить',
      revokeConfirm: '⚠️ Подтвердить экстренный отзыв доступа?\n\nЭто:\n1. Немедленно остановит бот\n2. Платформа не сможет выполнять сделки\n3. Средства остаются в контракте, вывод в любое время\n\nПодтвердить?',
      revoking: 'Отзыв доступа...', revoked: 'Доступ отозван — платформа не может оперировать средствами'
    },
    settings: {
      title: 'Настройки Торговли', strategy: 'Стратегия',
      conservative: 'Консервативная (низкий риск)', balanced: 'Сбалансированная (рекомендуется)', aggressive: 'Агрессивная (высокая доходность)',
      maxSingle: 'Макс. сделка (USDT)', dailyLimit: 'Дневной лимит (USDT)',
      save: 'Сохранить', cancel: 'Отмена', saved: 'Настройки сохранены'
    },
    dash: {
      balance: 'Баланс Vault', loading: 'Загрузка...',
      positions: 'Позиции', empty: 'Нет позиций',
      running: 'Активна', paused: 'Пауза', engineOff: 'Движок выкл',
      totalPnl: 'Общий P&L', pnlDetail: 'Общий P&L | {0} сделок',
      risk: 'Управление рисками', riskNormal: 'Норма', riskDetail: 'За сделку: $50,000 | В день: $200,000',
      posDetail: 'Детали позиций', recentTrades: 'Последние сделки', noTrades: 'Нет сделок'
    },
    withdraw: {
      title: 'Вывод', usdt: 'Вывести весь USDT', bnb: 'Вывести весь BNB',
      desc: 'Средства вернутся напрямую в TP Wallet',
      usdtConfirm: 'Вывести весь USDT в TP Wallet?',
      bnbConfirm: 'Вывести весь BNB в TP Wallet?',
      processing: 'Вывод...', usdtOk: 'USDT выведен', bnbOk: 'BNB выведен'
    },
    footer: 'ARK Quant Agent v3.0 · Смарт-контракт кошелёк · On-chain безопасность'
  },

  ar: {
    lang: 'العربية', dir: 'rtl',
    login: {
      title: 'ARK Quant Agent',
      subtitle: 'محفظة العقود الذكية · تداول آلي بالكامل',
      desc: 'أموالك في عقود على السلسلة، آمنة وقابلة للتحكم',
      step1: 'تسجيل الدخول عبر TP Wallet (بدون مفتاح خاص)',
      step2: 'نشر محفظة عقود خاصة بك بنقرة واحدة',
      step3: 'تحويل USDT إلى محفظة العقود',
      step4: 'بدء التداول — آلي بالكامل',
      connect: 'ربط TP Wallet',
      connecting: 'جاري الاتصال...',
      signing: 'يرجى تأكيد التوقيع في TP Wallet...',
      verifying: 'التحقق من التوقيع...',
      success: 'تم تسجيل الدخول',
      placeholder1: 'عنوان المحفظة (0x...)',
      placeholder2: 'كلمة المرور',
      loginBtn: 'تسجيل الدخول',
      divider: 'مستخدم جديد؟',
      registerBtn: 'حساب جديد',
      registering: 'جاري التسجيل...',
      registerOk: 'تم التسجيل وتسجيل الدخول تلقائيًا',
      loginFooter: 'أدخل عنوان محفظة BSC وكلمة المرور',
      fee: 'رسوم المنصة 20% (عند الأرباح فقط)',
      noWallet: 'يرجى الفتح في متصفح TokenPocket أو تثبيت TP Wallet'
    },
    header: { version: 'v3.0 وضع العقود الذكية', logout: 'تسجيل خروج' },
    status: {
      vault: 'Vault', deployed: 'تم النشر', undeployed: 'غير منشور',
      trading: 'التداول', running: 'يعمل', off: 'متوقف',
      strategy: 'الاستراتيجية', fee: 'الرسوم', users: 'المستخدمون'
    },
    deploy: {
      title: 'نشر محفظة العقود الذكية',
      desc: 'كل مستخدم لديه محفظة عقود معزولة. الأموال منفصلة تمامًا — المنصة لها فقط حق تنفيذ التداولات.',
      s1t: 'تسجيل', s1d: 'عنوان المحفظة + كلمة المرور',
      s2t: 'نشر', s2d: 'نشر Vault',
      s3t: 'إيداع', s3d: 'USDT / BNB',
      s4t: 'التداول', s4d: 'آلي بالكامل',
      btn: 'نشر محفظة العقود',
      deploying: 'جاري النشر (يحتاج تأكيد TP)...',
      confirm: 'جاري نشر Vault — يرجى التأكيد في TP Wallet...',
      success: 'تم نشر Vault!', failed: 'فشل النشر'
    },
    ctrl: {
      start: 'بدء التداول', stop: 'إيقاف التداول', revoke: 'إلغاء صلاحية طارئ',
      settings: 'الإعدادات', refresh: 'تحديث',
      revokeConfirm: '⚠️ تأكيد إلغاء الصلاحية الطارئ؟\n\nهذا سيؤدي إلى:\n1. إيقاف البوت فورًا\n2. المنصة لا يمكنها تنفيذ أي صفقات\n3. أموالك في العقد ويمكن سحبها في أي وقت\n\nتأكيد؟',
      revoking: 'جاري إلغاء الصلاحية...', revoked: 'تم الإلغاء — المنصة لا يمكنها الوصول لأموالك'
    },
    settings: {
      title: 'إعدادات التداول', strategy: 'الاستراتيجية',
      conservative: 'تحفظي (مخاطر منخفضة)', balanced: 'متوازن (موصى به)', aggressive: 'هاجف (عائد مرتفع)',
      maxSingle: 'أقصى صفقة (USDT)', dailyLimit: 'الحد اليومي (USDT)',
      save: 'حفظ', cancel: 'إلغاء', saved: 'تم الحفظ'
    },
    dash: {
      balance: 'رصيد Vault', loading: 'جاري التحميل...',
      positions: 'المراكز', empty: 'لا مراكز',
      running: 'يعمل', paused: 'متوقف مؤقتاً', engineOff: 'المحرك متوقف',
      totalPnl: 'إجمالي الربح/الخسارة', pnlDetail: 'إجمالي P&L | {0} صفقة',
      risk: 'إدارة المخاطر', riskNormal: 'طبيعي', riskDetail: 'لكل صفقة: $50,000 | يوميًا: $200,000',
      posDetail: 'تفاصيل المراكز', recentTrades: 'التداولات الأخيرة', noTrades: 'لا صفقات'
    },
    withdraw: {
      title: 'سحب', usdt: 'سحب كل USDT', bnb: 'سحب كل BNB',
      desc: 'السحب يعود مباشرة إلى TP Wallet',
      usdtConfirm: 'سحب كل USDT إلى TP Wallet؟',
      bnbConfirm: 'سحب كل BNB إلى TP Wallet؟',
      processing: 'جاري السحب...', usdtOk: 'تم سحب USDT', bnbOk: 'تم سحب BNB'
    },
    footer: 'ARK Quant Agent v3.0 · محفظة العقود الذكية · أمان على السلسلة'
  },

  es: {
    lang: 'Español', dir: 'ltr',
    login: {
      title: 'ARK Quant Agent',
      subtitle: 'Billetera de Smart Contract · Trading Automático',
      desc: 'Tus fondos están en contratos on-chain, seguros y controlables',
      step1: 'Iniciar con TP Wallet (sin clave privada)',
      step2: 'Desplegar tu billetera de contrato personal',
      step3: 'Transferir USDT a la billetera de contrato',
      step4: 'Iniciar trading — completamente automático',
      connect: 'Conectar TP Wallet',
      connecting: 'Conectando...',
      signing: 'Confirma la firma en TP Wallet...',
      verifying: 'Verificando firma...',
      success: 'Inicio de sesión exitoso',
      placeholder1: 'Dirección de billetera (0x...)',
      placeholder2: 'Contraseña',
      loginBtn: 'Iniciar sesión',
      divider: '¿Nuevo usuario?',
      registerBtn: 'Crear cuenta',
      registering: 'Registrando...',
      registerOk: 'Registrado e iniciado sesión',
      loginFooter: 'Ingresa tu dirección de billetera BSC y contraseña',
      fee: 'Comisión 20% (solo en ganancias)',
      noWallet: 'Abre en el navegador TokenPocket o instala TP Wallet'
    },
    header: { version: 'v3.0 Modo Smart Contract', logout: 'Salir' },
    status: {
      vault: 'Vault', deployed: 'Desplegado', undeployed: 'No desplegado',
      trading: 'Trading', running: 'Activo', off: 'Apagado',
      strategy: 'Estrategia', fee: 'Comisión', users: 'Usuarios'
    },
    deploy: {
      title: 'Desplegar Tu Billetera de Smart Contract',
      desc: 'Cada usuario tiene una billetera aislada. Los fondos están completamente separados — la plataforma solo tiene permiso de ejecución.',
      s1t: 'Iniciar', s1d: 'Dirección + contraseña',
      s2t: 'Desplegar', s2d: 'Desplegar Vault',
      s3t: 'Fondear', s3d: 'USDT / BNB',
      s4t: 'Trading', s4d: 'Automático',
      btn: 'Desplegar Mi Billetera',
      deploying: 'Desplegando (requiere confirmación TP)...',
      confirm: 'Desplegando Vault — confirma en TP Wallet...',
      success: '¡Vault desplegado!', failed: 'Error al desplegar'
    },
    ctrl: {
      start: 'Iniciar Trading', stop: 'Detener Trading', revoke: 'Revocar Urgente',
      settings: 'Configuración', refresh: 'Actualizar',
      revokeConfirm: '⚠️ ¿Confirmar revocación urgente?\n\nEsto:\n1. Detendrá el bot inmediatamente\n2. La plataforma no puede ejecutar trades\n3. Tus fondos permanecen en el contrato\n\n¿Confirmar?',
      revoking: 'Revocando acceso...', revoked: 'Acceso revocado'
    },
    settings: {
      title: 'Configuración', strategy: 'Estrategia',
      conservative: 'Conservador (Bajo riesgo)', balanced: 'Balanceado (Recomendado)', aggressive: 'Agresivo (Alto retorno)',
      maxSingle: 'Máx por trade (USDT)', dailyLimit: 'Límite diario (USDT)',
      save: 'Guardar', cancel: 'Cancelar', saved: 'Guardado'
    },
    dash: {
      balance: 'Saldo Vault', loading: 'Cargando...',
      positions: 'Posiciones', empty: 'Sin posiciones',
      running: 'Activo', paused: 'Pausado', engineOff: 'Motor apagado',
      totalPnl: 'P&L Total', pnlDetail: 'P&L Total | {0} trades',
      risk: 'Control de Riesgo', riskNormal: 'Normal', riskDetail: 'Por trade: $50,000 | Diario: $200,000',
      posDetail: 'Detalles de Posiciones', recentTrades: 'Trades Recientes', noTrades: 'Sin trades'
    },
    withdraw: {
      title: 'Retirar', usdt: 'Retirar Todo USDT', bnb: 'Retirar Todo BNB',
      desc: 'Los fondos van directo a tu TP Wallet',
      usdtConfirm: '¿Retirar todo USDT a TP Wallet?',
      bnbConfirm: '¿Retirar todo BNB a TP Wallet?',
      processing: 'Retirando...', usdtOk: 'USDT retirado', bnbOk: 'BNB retirado'
    },
    footer: 'ARK Quant Agent v3.0 · Billetera Smart Contract · Seguridad On-chain'
  },

  pt: {
    lang: 'Português', dir: 'ltr',
    login: {
      title: 'ARK Quant Agent',
      subtitle: 'Carteira de Smart Contract · Trading Automático',
      desc: 'Seus fundos estão em contratos on-chain, seguros e controláveis',
      step1: 'Entrar com TP Wallet (sem chave privada)',
      step2: 'Implantar sua carteira de contrato pessoal',
      step3: 'Transferir USDT para a carteira de contrato',
      step4: 'Iniciar trading — totalmente automático',
      connect: 'Conectar TP Wallet',
      connecting: 'Conectando...',
      signing: 'Confirme a assinatura no TP Wallet...',
      verifying: 'Verificando assinatura...',
      success: 'Login bem-sucedido',
      placeholder1: 'Endereço da carteira (0x...)',
      placeholder2: 'Senha',
      loginBtn: 'Entrar',
      divider: 'Novo usuário?',
      registerBtn: 'Criar conta',
      registering: 'Registrando...',
      registerOk: 'Registrado e logado',
      loginFooter: 'Digite o endereço da carteira BSC e senha',
      fee: 'Taxa 20% (apenas nos lucros)',
      noWallet: 'Abra no navegador TokenPocket ou instale TP Wallet'
    },
    header: { version: 'v3.0 Modo Smart Contract', logout: 'Sair' },
    status: {
      vault: 'Vault', deployed: 'Implantado', undeployed: 'Não implantado',
      trading: 'Trading', running: 'Ativo', off: 'Desligado',
      strategy: 'Estratégia', fee: 'Taxa', users: 'Usuários'
    },
    deploy: {
      title: 'Implantar Sua Carteira Smart Contract',
      desc: 'Cada usuário tem uma carteira isolada. Fundos totalmente separados — a plataforma só tem permissão de execução.',
      s1t: 'Entrar', s1d: 'Endereço + senha',
      s2t: 'Implantar', s2d: 'Implantar Vault',
      s3t: 'Depositar', s3d: 'USDT / BNB',
      s4t: 'Trading', s4d: 'Automático',
      btn: 'Implantar Minha Carteira',
      deploying: 'Implantando (requer confirmação TP)...',
      confirm: 'Implantando Vault — confirme no TP Wallet...',
      success: 'Vault implantado!', failed: 'Falha na implantação'
    },
    ctrl: {
      start: 'Iniciar Trading', stop: 'Parar Trading', revoke: 'Revogar Urgente',
      settings: 'Configurações', refresh: 'Atualizar',
      revokeConfirm: '⚠️ Confirmar revogação urgente?\n\nIsso:\n1. Para o bot imediatamente\n2. A plataforma não pode executar trades\n3. Seus fundos permanecem no contrato\n\nConfirmar?',
      revoking: 'Revogando acesso...', revoked: 'Acesso revogado'
    },
    settings: {
      title: 'Configurações', strategy: 'Estratégia',
      conservative: 'Conservador (Baixo risco)', balanced: 'Balanceado (Recomendado)', aggressive: 'Agressivo (Alto retorno)',
      maxSingle: 'Máx por trade (USDT)', dailyLimit: 'Limite diário (USDT)',
      save: 'Salvar', cancel: 'Cancelar', saved: 'Salvo'
    },
    dash: {
      balance: 'Saldo Vault', loading: 'Carregando...',
      positions: 'Posições', empty: 'Sem posições',
      running: 'Ativo', paused: 'Pausado', engineOff: 'Motor desligado',
      totalPnl: 'P&L Total', pnlDetail: 'P&L Total | {0} trades',
      risk: 'Controle de Risco', riskNormal: 'Normal', riskDetail: 'Por trade: $50,000 | Diário: $200,000',
      posDetail: 'Detalhes', recentTrades: 'Trades Recentes', noTrades: 'Sem trades'
    },
    withdraw: {
      title: 'Retirar', usdt: 'Retirar Todo USDT', bnb: 'Retirar Todo BNB',
      desc: 'Os fundos vão direto para sua TP Wallet',
      usdtConfirm: 'Retirar todo USDT para TP Wallet?',
      bnbConfirm: 'Retirar todo BNB para TP Wallet?',
      processing: 'Retirando...', usdtOk: 'USDT retirado', bnbOk: 'BNB retirado'
    },
    footer: 'ARK Quant Agent v3.0 · Carteira Smart Contract · Segurança On-chain'
  }
};

window.I18N = I18N;

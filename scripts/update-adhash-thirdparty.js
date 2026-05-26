const fs = require('fs');
const path = require('path');

const QA_DATA_PATH = path.join(__dirname, '..', 'data', 'qa-shared.json');
const data = JSON.parse(fs.readFileSync(QA_DATA_PATH, 'utf8'));

if (!data['qa3_adhash']) data['qa3_adhash'] = {};

const entries = [
  {
    name: 'WiFi Passwords',
    username: '',
    tpPassword: '',
    url: '',
    environment: 'Internal',
    note: 'Tech Act: admin@123 | Tech Act 5Ghz: admin@123 | Sync Jio Fiber: Hash@54321 | Sync Jio Fiber 5G: Hash@54321 | Synctag DM: Dmsynctag@2019 | Demo: 123@Demo | Adhash Tech 4G & 5G: Tech@2023 | ADHASH: adhash@123 | ADHASH_ASIA: 2026@adhash | Airtel Adhash 5G: Adhash@2024'
  },
  {
    name: 'Gmail App Passwords',
    username: '',
    tpPassword: '',
    url: 'https://myaccount.google.com/apppasswords',
    environment: 'Production',
    note: 'ahqateam@gmail.com — App Pass: erhi dluf atbm mpwf | thenilavan@adhashtech.com — App Pass: jTrEFy5swGSF (KCAI_Automation) | thenilavanadhashtester@gmail.com — App Pass: zuzz qrpx hzvz rwmc | Jenkins Gmail App Pass: dxzs smnk mmuy zzlc / xhra vrcy pvmx jgmc'
  },
  {
    name: 'Zoho App Password',
    username: 'thenilavan@adhashtech.com',
    tpPassword: 'G8sYN8MRCWpM',
    url: 'https://accounts.zoho.com/home#security/app_password',
    environment: 'Production',
    note: 'App name: Adhash_Certificate_Test'
  },
  {
    name: 'Tenovi',
    username: 'harsh@smgmt.co',
    tpPassword: 'Synctag@2025',
    url: 'https://app.tenovi.com/authentication/login',
    environment: 'Production',
    note: ''
  },
  {
    name: 'Sinch MessageMedia',
    username: 'harsh@smgmt.co',
    tpPassword: 'Synctag@007',
    url: 'https://hub.messagemedia.com/login',
    environment: 'Production',
    note: ''
  },
  {
    name: 'Vonage App',
    username: 'hmehta',
    tpPassword: 'Synctag@2025',
    url: 'https://app.vonage.com/',
    environment: 'Production',
    note: 'Login URL also: https://login.auth.vonage.com/authenticationendpoint/login.do | Alt login: hmehta12 / Synctag@2027'
  },
  {
    name: 'Vonage Dev Portal',
    username: 'synctagteste@gmail.com',
    tpPassword: 'Vonage@12345#',
    url: 'https://ui.idp.vonage.com/ui/auth/login',
    environment: 'Development',
    note: 'API Key Production: kLQWIM4P.hWze2PS5V6vzecgnkIYFWdpLx4yAqjnK | API Key Dev: KTLK7tvz.k4lSBC6Sop6t0nb0R9D7jWjjQIwWywbd'
  },
  {
    name: 'Gmail Accounts',
    username: '',
    tpPassword: '',
    url: 'https://mail.google.com',
    environment: 'Production',
    note: 'waivedin@gmail.com: Waivedin@1 / w@123aivedin | fastlabhealth@gmail.com: Fastlab@1 | adhashmobiledevelopers@gmail.com: Adhash@20264 | spark.adhashtech@gmail.com: Spark@Dev123# | adhashzeplin@gmail.com: adhashzeplin@2022 | synctagoperation@gmail.com: Admin$ynct2g | anjunair0714@gmail.com: Synctag@1 or 2 | prasanthnairtester@outlook.com: Synctag@1 | prasanthnairtester@gmail.com: Synctag@1 | kevinfeige34@gmail.com: Synctag@1 | testuat1234567@gmail.com: Synctag@1 or Dio@2027 | myhealthaia@gmail.com: Myhealthai@123 | myhealthaia@outlook.com: Myhealthai@123 | Synctagai@gmail.com: Synctagai@123 | myhealthrtm@gmail.com: Myhealthrtm@123 | leadgenproces@gmail.com: Adhash@123 | adhashtechai@gmail.com: AdHashTechAI@* | autocheckerparts@gmail.com: AutoCheck#123456'
  },
  {
    name: 'Testing Gmail Accounts',
    username: '',
    tpPassword: 'Test@12345',
    url: 'https://mail.google.com',
    environment: 'Staging',
    note: 'All use password Test@12345: wavedintesting1@gmail.com | wavedintesting2@gmail.com | sparkmetesting1@gmail.com | sparkmetesting2@gmail.com | myhealthaitesting1@gmail.com | myhealthaitesting2@gmail.com | projectdemotesting1@gmail.com | projectdemotesting2@gmail.com'
  },
  {
    name: 'GitHub Personal Access Tokens',
    username: '',
    tpPassword: '',
    url: 'https://github.com/settings/tokens',
    environment: 'Production',
    note: 'PAT 1: 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 | PAT 2: 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'
  },
  {
    name: 'AutoChecker — Server Details',
    username: '',
    tpPassword: '',
    url: '',
    environment: 'Production',
    note: 'Commands: pm2 list | pm2 start app.js | pm2 logs 0 | pm2 stop {id} | Visual Studio stop: Ctrl+C | Manual Search (pm2): IP 20.15.121.70 user autocheckerscrappy pass autocheckerprod@Scrappy123# | Auto Search (pm2): IP 20.7.146.191 user autocheckerloader pass autocheckerprod@loader123# | PartSouq Search (nest start): IP 20.62.109.239 user AutoCheckerPartsouq pass AutoCheckerPartsouq@Dev1234# | VM 20.204.154.84: user AutoCheckerPartsouq pass AutoCheckerPartsouq@Dev1234# | VM 20.204.137.250: user autocheckerscrappy pass autochecker@Develop123#'
  },
  {
    name: 'ExpressVPN',
    username: 'autocheckerparts@gmail.com',
    tpPassword: 'wyfaXXJk',
    url: 'https://www.expressvpn.com/sign-in',
    environment: 'Production',
    note: 'Activation Key: EKQRAFPZFBJKZR2Q8CSCWJ5'
  },
  {
    name: 'Apple IDs',
    username: '',
    tpPassword: '',
    url: 'https://appleid.apple.com',
    environment: 'Production',
    note: 'Adhash.qa@icloud.com: Tester@123 | aditi@sparkme.app: ConnectSpark@101023 | 8148040687 / qateam@adhashtech.com: Synctag@1 | artamigosonline@gmail.com: Adhash@123'
  },
  {
    name: 'Stripe',
    username: '',
    tpPassword: '',
    url: 'https://dashboard.stripe.com/login',
    environment: 'Production',
    note: 'synctagteste@gmail.com: Synctag@12345 Backup: kcui-kvmo-szol-utye-uxyn | testesynctag@gmail.com: Synctag@12345 | thenilavan@adhashtech.com: Synctag@12345 | thenilavanadhashtester@gmail.com: Synctag@12345 Backup: fdfv-sjyq-iuba-bhux-dryx | 2FA: Google Authenticator on iPhone XR'
  },
  {
    name: 'AdHash Testing Phone Numbers',
    username: '',
    tpPassword: '',
    url: '',
    environment: 'Internal',
    note: 'iPhone XR: 8438540276 | OnePlus 5T: 8148040687 | Samsung A20s: 7094123587'
  },
  {
    name: 'Jenkins',
    username: '',
    tpPassword: 'd87b04d2b4c0410eab757600006651da',
    url: 'http://localhost:8080',
    environment: 'Internal',
    note: 'Start: java -jar jenkins.war | TestNG: mvn clean test -DtestngFile=TestNG.xml | Path: E:\\Thenilavan\\Automation\\eclipse-workspace\\AutoChecker | Tag filter: mvn test -Dcucumber.filter.tags="@smoke and @regression" | JMeter result CSV: E:\\Jmeter\\CSV\\result.csv'
  },
  {
    name: 'SendGrid',
    username: 'myhealthaitech',
    tpPassword: 'Myhealthai@12345',
    url: 'https://app.sendgrid.com',
    environment: 'Production',
    note: ''
  },
  {
    name: 'Twilio',
    username: 'myhealthaia@gmail.com',
    tpPassword: 'myhealthai@12345',
    url: 'https://console.twilio.com',
    environment: 'Production',
    note: 'Low Volume Mixed A2P Messaging Service SID: MGbdfe1f0f180ef5571c405ca9361792e4'
  },
  {
    name: 'Zeplin',
    username: 'adhashzeplin@gmail.com',
    tpPassword: 'adhashzeplin@2022',
    url: 'https://app.zeplin.io/project/64cdf3c3ce6cf11f90fd08a7/dashboard',
    environment: 'Production',
    note: ''
  },
  {
    name: 'eBay',
    username: 'partsbrokersllc',
    tpPassword: '$$Nahum177$$',
    url: 'https://www.ebay.com/signin',
    environment: 'Production',
    note: 'Phone: +17707782602 | Dev account: harsh@lifehopetech.com / Panemara@12 | Dev email: mm@autoevantage.com / AutoDog7!@#'
  },
  {
    name: 'Encrypt Keys',
    username: '',
    tpPassword: '',
    url: '',
    environment: 'Internal',
    note: 'Key 1: xfnr3PVyckouBZxW | Key 2: 3s5v8y/B?E(H+MbQ | Key 3: 7kINb4B2G4AnaCUq'
  },
  {
    name: 'ADB Device IDs',
    username: '',
    tpPassword: '',
    url: '',
    environment: 'Internal',
    note: 'Google Pixel 3XL: 94GAX0DWRK | Samsung: R9SMA0APEDJ'
  },
  {
    name: 'Firebase',
    username: '',
    tpPassword: '',
    url: 'https://console.firebase.google.com',
    environment: 'Production',
    note: 'My Health AI (CCM & RTM): myhealthaia@gmail.com / Myhealthai@123 | KaiCare AI (Patient): kaicareaiapplication@gmail.com / Adhash@123 | Humee Participant: myhealthrtm@gmail.com / AdhashRTM@2026 | Humee: adhashtechservers@gmail.com / Synctag@2025 or Adhash@2026 | Auto eVantage: autoevantageecommerce@gmail.com | AiSignPro or MHRTM (Old): myhealthrtm@gmail.com / Myhealthrtm@123 or AdhashRTM@2026 | Ask EPI & Risk Realm: adhashtechai@gmail.com / Adhash@2026 | WavedIn: waivedin@gmail.com / Waivedin@1 or w@123aivedin | SparkMe: spark.adhashtech@gmail.com / Spark@Dev123# | AdHash Mobile Dev: adhashmobiledevelopers@gmail.com / Adhash@20264'
  },
  {
    name: 'Algomax — Msg91 & DLT',
    username: 'copytradealgo@gmail.com',
    tpPassword: 'A0JUT6QJ',
    url: 'https://msg91.com/in',
    environment: 'Production',
    note: 'Mobile: 8438540276 | DLT: https://smartping.live/entity/user-profile user copytradealgo@gmail.com pass A0JUT6QJ'
  },
  {
    name: 'ChatGPT',
    username: 'ahqateam@adhashtech.com',
    tpPassword: 'Tester@123',
    url: 'https://chatgpt.com/',
    environment: 'Production',
    note: ''
  },
  {
    name: 'Testsigma',
    username: 'thenilavan@adhashtech.com',
    tpPassword: 'Synctag@123',
    url: 'https://test-management.testsigma.com/',
    environment: 'Production',
    note: ''
  },
  {
    name: 'Udemy',
    username: 'qateam@adhashtech.com / thenilavan012@gmail.com',
    tpPassword: '',
    url: 'https://www.udemy.com/',
    environment: 'Production',
    note: 'Both accounts use OTP — ask admin for OTP'
  },
  {
    name: 'Burp Suite',
    username: 'thenilavan@adhashtech.com',
    tpPassword: "zY5NT55Y4n79]D7Wd'29TP&k7dto@5}z",
    url: 'https://portswigger.net/users',
    environment: 'Production',
    note: ''
  },
  {
    name: 'Tavus',
    username: '',
    tpPassword: '',
    url: 'https://platform.tavus.io',
    environment: 'Production',
    note: 'API Key: 546b22cc18e640959013aa395e01c6fe'
  },
  {
    name: 'Apollo',
    username: 'adhashnodeteams@gmail.com',
    tpPassword: 'Adhashnod@2025',
    url: 'https://app.apollo.io/#/login?locale=en',
    environment: 'Production',
    note: ''
  },
];

data['qa3_adhash'].thirdparty = entries;
fs.writeFileSync(QA_DATA_PATH, JSON.stringify(data, null, 2));
console.log('Written', entries.length, 'third party entries to qa3_adhash');
entries.forEach((e, i) => console.log(i + 1, e.name));

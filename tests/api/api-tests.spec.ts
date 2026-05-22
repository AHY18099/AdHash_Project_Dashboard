// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';

const APIS = [
  {
    "name": "AdHash — AdHash Website",
    "url": "https://adhashtech.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "WavedIn — WavedIn App Login",
    "url": "https://mobileliveapi.wavedin.app/api/auth/login",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "Z6bJc+TJLSyk2k2zcjRDzB1b2SUMLqPMDJ7onRlphDDf9wwCF941EGsE928j/4PLQs6wcVXsDfQsyKWO6thxZvIflmVvWtgGAe2UT/c5on37m45Ge5BUDL3PnbKo774KRf4q1kM8GoJxF5nVeqF8C5pBVwwdKkFK5MyLPqTyzlCHof+IKxJOrMRFCe+HNPsuRdkf6rxr56sMhXrPQu8OP7VMlDa89QIrl5D4zYnb1msDUgfKvjl0gVX7AkZnUMZUE5FemJnx7sS1JggiuM5lEQVKivjgElAaiFlLhfSenmUlUdL037feg6oIRCwEhMxkYr3H9CXt7VRpwfB6TBElyvdftVi3cUyNV+l1l/uMzbM1/0gj2n0qntbeWti+vwhJwV7rHKJyxST7vDSkWC4rggTEabs9gkg7x3fMKGb58t1oO4MgCdku8Gou9TPEVyNbSZ7skRONiCE55ZUkwU/tYljSFvT/ljQF6cDLibuKHW6sk4j/ZtP0jN/MtHJUozkOLVEOzt+ZXjip++f7SRokIOHdmJ5jsU/FHgfVNy3h7LuBgdBMtiY8MqmRIxFyueoL9n1FyopW5yluQnUk6ok09Z8/4V5yVsfe7e6HszOYFgScgzmQcuDiegp4pSXDYx25EleDhYtW0SLi5fnXOKPrxo0qBmjlhhOY/XNPNEamlxM="
    },
    "expectedStatus": 200
  },
  {
    "name": "WavedIn — WavedIn SuperAdmin UI",
    "url": "https://superadmin.wavedin.app/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "WavedIn — WavedIn Market Web",
    "url": "https://market.wavedin.app/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "Algomax — Algomax ProSky Web",
    "url": "https://prosky.algomax.co",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "Algomax — Algomax GoPocket Web",
    "url": "https://gopocket.algomax.co",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "AutoChecker — AutoChecker Login UI",
    "url": "https://manage.autochecker.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "AutoChecker — AutoChecker Admin Login",
    "url": "https://manageadminapi.autochecker.com/adminapi/auth/login",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json"
    },
    "body": {
      "key": "qYkPMqAmQziJ2/ha1YnKS6xxJOJ7gynA4+DtvRPHnPpm3mrqpgjLhZRUg1446ixEOcORY30MpQ8o0h+Kf9cyVqxk/I5LMYc9qhLtyAWZcco="
    },
    "expectedStatus": 201
  },
  {
    "name": "AutoChecker — AutoChecker App Login",
    "url": "https://managemobileapi.autochecker.com/api/auth/login",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "o7obaAPl8Rin1yQil/fPLmfZDWV31ERB6O+us/ZdZlwAmt3brpIPLVi8W2ASbZ9dzes3tBTEjYwcayoLQ316BQ=="
    },
    "expectedStatus": 200
  },
  {
    "name": "Spark me — Sparkme App Login",
    "url": "https://spark.synctag.com/api/auth/login",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "z8zY9agO/zG58XoDO6QW+mkPueQVBAGXwPCbsyAIPxmbvDYcouZ/ssu6jpPMct47MGerqC9we10NCiVzoijbNwohTjUh+ozT0NUPmK4s2hpDCXxBlqitk2TpfqwxEL2at+DW8bPJ69BBSnbG/PRM3VItB8USK2N5iBGiHaOG1ngUdOzDFJT3FU//ZQ1ATW8BBEUtJ9rGIQ2+Uqg/0f/tVk9+yGQQyITObqIPXWvIQ+AMxs/0XNELfe90Ou+D5eMuGwH3ZiMe8SpCU9Uo0ZXdXC+me/xjlyEu1uXduyTcYV2ZP9+Qe7pZgSHJrpUHsgLFVEVcZp89DQG9VeVcz8P8zwXLumfIaTacMLPWzl+j1XBWMLD2cBq4gGvVNbPKTl/OwnDMgYz0XYBR5E6VPbDk6zjAT0cns14L/vhuwIAorVmTX2fbfvDWWIQD8zy4A0vNtPe206zYNMLwWRHkonvEvpqxvL4Ri2gfjN1kV7kwxwjYOwQ+vAkfTZpEbH2CHVTVsCyKVNfGphZDdQYECe0UzwlKTdxr/jrVno4V8kRschF6E8jwXlukeNpdryN/zAdRFkRZSGbHIbIwIScwmsmBIKkbYRt9Bzrl4Xn3ksKwVRM6zh66z9YSmksvwkTmk9vQ"
    },
    "expectedStatus": 200
  },
  {
    "name": "Spark me — Sparkme Web Login UI",
    "url": "https://sparkanalytics.synctag.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "Spark me — Sparkme Web Login",
    "url": "https://spark.synctag.com/analyticsapi/auth/login",
    "method": "POST",
    "headers": {},
    "body": {
      "phone": 9999999999,
      "password": "Synctag@1"
    },
    "expectedStatus": 200
  },
  {
    "name": "Humee — Humee Admin Web UI",
    "url": "https://www.humee.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "Humee — Humee Dashboard Web UI",
    "url": "https://dashboard.humee.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "Humee — Humee Desktop Web UI",
    "url": "https://desktop.humee.com",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "Humee — Humee Dashboard Login Check",
    "url": "https://api.humee.com/api/users/beforeLogincheckUser",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "fUjZB3a_IJyX6AyCgxVZ4pop-Mu29uTqwJQ7zpvAo1Ove6XhrcwJK77ZsAyebakj"
    },
    "expectedStatus": 200
  },
  {
    "name": "Humee — Humee Dashboard Login OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIzaSyB6Fk4wRtuKFPL_2BToGZuGP7bOGUH08lQ",
    "method": "POST",
    "headers": {},
    "body": {
      "sessionInfo": "AD8T5ItYv_dvp2B6t8uZbWQvvV3vc1XB9lPmk1ET95hWjvCVUQP2SFc9W6nUGmXHoGRW_PwuMA4UNz40Rw2kFeDAgKNXZ9Q2BQYO76bivCM2Pu4Yp_OPpEfM_-M5wonI2597C1ZurCA2bouSZ5hKKzbK7oQin7qcCQ",
      "code": "123456"
    },
    "expectedStatus": 200
  },
  {
    "name": "Humee — Humee Dashboard Login",
    "url": "https://api.humee.com/api/users/login",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "Dda1sQBpMyyi1OLjbzVM2186-B4y0pWcASJE5eVtTdtsUrwPkPkowkIGaSE4qEakF374sR1GVTAR6lRI4LvDnBTM7E_12YWeE4EVMSje5TjQhF_ja0MQVYZZnKdmgNmx"
    },
    "expectedStatus": 200
  },
  {
    "name": "Metcalf — Metcalf UI",
    "url": "https://metcalf.ai/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro SuperAdmin UI",
    "url": "https://admin.aisignpro.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro SuperAdmin Check User",
    "url": "https://api.aisignpro.com/api/user/userExists",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "fUjZB3a/IJyX6AyCgxVZ4r+mOOJSBWMIR1JBrMqkopiPOE+zUbMgVXNfVffuPIHBM+oYhZUbxG8IEFoCA1VIusbDZ0iWfiMl7DxmmvO3XWo="
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro SuperAdmin OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIzaSyBAf4PM4HeNcO0uuByCUWwZFIYMYHfwUik",
    "method": "POST",
    "headers": {},
    "body": {
      "sessionInfo": "AD8T5Itcs-MC9t7FWRkKl51XvapzgqVn0f05dvGi1_mTUHIVUfn-RC6JrsXg3V-Pl_FZ-AP8ByGukF9zmGyJjWrjgNeM8UueDxdKynr1zrM5bICu39WEGwKA-vS5wf8JOjWuyw_4vvDltWEGFCf28jLHAgRwyVZl2A",
      "code": "123456"
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro SuperAdmin Login",
    "url": "https://api.aisignpro.com/api/user/login",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "UolFVSl619gADNtaLskiYQhzCJ4ARYCdvE95I5cA6GCGUlVImhrFmv62BN2OfozsXZE5CxD8J/m6gjTJfY0i769gz73TVFeOmz/QH7apgFYF/DC8sFJUU8UXlbIWJwhV"
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro DDP Admin Check User",
    "url": "https://api.aisignpro.com/api/user/userExists",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "fUjZB3a/IJyX6AyCgxVZ4r+mOOJSBWMIR1JBrMqkophcVRCpKiN7DhiHyWrv+9B2uFx8dgH0honioLEXw6gaKskdJPf9Z3sE2mNzSVEB5Z0="
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro DDP Admin OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIzaSyBAf4PM4HeNcO0uuByCUWwZFIYMYHfwUik",
    "method": "POST",
    "headers": {},
    "body": {
      "sessionInfo": "AD8T5IvU7VyodI7-BTy1cG9QWq63xADt4oAho_0Ub319k0jloE5Q1U4tDx67EMJpeWZCxX0cAQKGlt43AFNeDYQKCrr05MDZS990RA-309kaa_IXXtSxpNfIRD_pTk5NdjpnkNgNBBuRZg5Cy4SNXEXJvgtqqouc4Q",
      "code": "123456"
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro DDP Admin Login",
    "url": "https://api.aisignpro.com/api/user/login",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "YfSrZl14SyT3q3EpHR7DPHyRC8dnzRVKGYLb8tmtvLxQ6lJS++PAHec1mN6SEerkjIKfdbtivRxj3BctpwgqPeMPKLawS99q7k3kDx8qdEOtYEm/PtDIG+Hxfz1wK61M"
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro Accountant Check User",
    "url": "https://api.aisignpro.com/api/user/userExists",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "fUjZB3a/IJyX6AyCgxVZ4r+mOOJSBWMIR1JBrMqkopjmpuDLCvhBDDmAX35a/cv+lIQUArLwTq3oPioihA+Eyz4hn8aJ9MG1SdNtuoznGaI="
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro Accountant OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIzaSyBAf4PM4HeNcO0uuByCUWwZFIYMYHfwUik",
    "method": "POST",
    "headers": {},
    "body": {
      "sessionInfo": "AD8T5IuATw5ArftpEnSEp1H5WoYhGXT2E5J9NvnpYlKXENs8sNpBYgCFwmSYhwbrbp7ZBKuEzvmXjT65jE_KF7tKzFNUY6oTguUoX7a-bWYXzS3MtQTNOHWSAj3Su5z0Tms_z1L8JqJD2jAMrojJpOP1sKC2iToWpQ",
      "code": "123456"
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro Accountant Login",
    "url": "https://api.aisignpro.com/api/user/login",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "4+BIJiBYlIqi7flceFSKm7HC5g8Sfgj9zrwy18U+55zlP44ttmvZBwnTaKUjFiS4AFgFoh7MQBK7ZoTzNHuFKwv+LsRDDRxSf9wTqSZd03MBqz9mGBb3uD0VQpRhtnbf"
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro CPA UI",
    "url": "https://cpa.aisignpro.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro CPA Check User",
    "url": "https://api.aisignpro.com/api/user/userExists",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "fUjZB3a/IJyX6AyCgxVZ4pop+Mu29uTqwJQ7zpvAo1NFyc7kh7n5T9A7n8UxHr5UDccVDAfHiZwP1AznUSLAdk8M20OTpqPmk8+Ztg7sQUg="
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro CPA OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIzaSyBAf4PM4HeNcO0uuByCUWwZFIYMYHfwUik",
    "method": "POST",
    "headers": {},
    "body": {
      "sessionInfo": "AD8T5Iu4-pA4ppm6fxOhUanYiW9LuYGI_WP976dG2f33MaAUMP-hEIyw8u-ee_A3MdHjoP5kGXHNQvpfD7OtxTyKspOF220HCwL8L_uvRkmU-LWbQX2Hi1nE-z5yWstKEAgQgyPQGL2QttvFcYl6_Ejl7qH-sd8WVg",
      "code": "123456"
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro CPA Login",
    "url": "https://api.aisignpro.com/api/user/login",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "zWnxj6lfy0D7gDyaQxeKeHisOe40qa4LDTWD8GOqqMsQPHx1QGlrQyMclLK1Udt3VoIVYWbgOympTcy6BoSct3ZdfZeZnGSQmBrgFrNyOUUsqEWS0gTxMGfzTIPQfExO"
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro Participant UI",
    "url": "https://client.aisignpro.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro Participant Check User",
    "url": "https://api.aisignpro.com/api/user/userExists",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "fUjZB3a/IJyX6AyCgxVZ4ptoOU69xEJf2qVsBQ7VAYAdP8ENeeaWWo48LSri6l0JuNeUW8Q/Ih0osGhb3r99lnzG3ix9JGzE8qvlQA+0hUs="
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro Participant OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIzaSyBAf4PM4HeNcO0uuByCUWwZFIYMYHfwUik",
    "method": "POST",
    "headers": {},
    "body": {
      "sessionInfo": "AD8T5IurUSCLqscWe6H4QjbA9HR605VMOpbvrWuDFu6K-XKxnZQXoL0i7VxqOWixp-FIa7AYRiGvo1j-ZwMeay-hvTsomVCoxFGWTupfcazujFS_jn7cQZryTV_Tgaw2jDoT6luWuvIA_mf9xLD0DhjNMG3T4JgJ7A",
      "code": "123456"
    },
    "expectedStatus": 200
  },
  {
    "name": "AiSign Pro — AiSignPro Participant Login",
    "url": "https://api.aisignpro.com/api/user/login",
    "method": "POST",
    "headers": {},
    "body": {
      "key": "Rvy06w8KodBbMGFiqM6pSf7DEqBcLV5Bh4w8qs7JYvibfkz/30fvl5qIlc2kP/gs3Msl7u08McNuW+7bwHlmCSNwpPrTEcwZ5IlZAtV1PuQb5rop2gbZNuLXEZXqhtdJ"
    },
    "expectedStatus": 200
  },
  {
    "name": "ZapCRM — ZapCRM UI",
    "url": "https://zapcrm.io/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "ZapCRM — Secure ZapCRM UI",
    "url": "https://secure.zapcrm.io/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "ZapCRM — Social ZapCRM UI",
    "url": "https://social.zapcrm.io/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "LeadZapCRM — Lead ZapCRM UI",
    "url": "https://lead.zapcrm.io/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "ZapAI — ZapAI UI",
    "url": "https://www.zapai.us/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "SMC — SMC API",
    "url": "https://api.sendmovieclips.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "SyncTrade — SyncTrade SuperAdmin Login Number",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=AIzaSyBQ-7vSNUN9lQhr7DwPALufUgOAmw1YbNY",
    "method": "POST",
    "headers": {},
    "body": {
      "phoneNumber": "+919876598765",
      "clientType": "CLIENT_TYPE_WEB",
      "captchaResponse": "NO_RECAPTCHA",
      "recaptchaVersion": "RECAPTCHA_ENTERPRISE",
      "recaptchaToken": "0cAFcWeA4I6NufRvLM0UW5310jsvwghA0QhOCjjoyYP4y_VJ3mUaqEg7vfS_8_VquNA2d3xe9hljxXJZvEPeT1FmvygDY1-Vm0L4bemBdlRoQy6laD8IXIhm8YEb8uN8WzYLeNdxenAjtHTvhxhFVGFpnALb6pcxoe_Ywg7CwyheL8miXwLCvM2S6KG6JQmPgsJC7sQcOahgixdyLHhVrDWKCwGsUPJImsimH4Q5M2HpBE4SVYjXWRiSeVh66TL8uHBUuByb9rdJ7nlU-I1Jl8wUxG-LrOGmmpidpbuA5oHYr8lSOWBgfsatMdaO4gKIucX8TxwSdCCikh0AaUBbNA29Afi6VAa6YEUAOjL5w3YoxvZHkB8JC0iwF5IEBiP8KVLg5cYU-klXUQzkpeDhnplxPxWSUkpf7eQN_57XM9bu9MIdk7WPh7q6sMjCUE-PEctpnp07ayU_bmNbnWcCvk0qXyPR_J-Mn5zP6O7Ni7rhwe0BQfXDy40TIwL_ea6DRLKSAJyPrmi0Pc_N-xrTOUgHMUG5qhbQ-txlc8AZLImfnCPP0Aeg7dT41m3idTSIWKut6cWvwuUJndf5wuC2ftvw9zGm7aUXVxyvY0CqNZ1MX9eu-XKlMixuYh7oYhq0MCTj5echXDqkuY53FbcWfECPMGpgVUySGOJ3BRU4vu5PKcic_K3APV-42gnQ4IIdARIH-xzKPYASYhBWCiltPLFfSfb38qS3EPxHP41GZSnt9na7N42WvXr3K1ihZ1mR4iMfnIhNo5N4IdmP5VkI4awarLTa63HuIhu1lZNRcfQQYCx1FL_yWvhSkf1rKcfwr6jurr0SL9AgI2_2DuPUahV_jYS8qaDirKfRcR8ZUbT2mGa4CTh3pipQTn6Dg_JIzKfNxRNnpgFLBbpoewN3cGohgwDcEDP8NSMtlK-BteIXemgMMwTkuUfyg"
    },
    "expectedStatus": 200
  },
  {
    "name": "SyncTrade — SyncTrade SuperAdmin Login OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIzaSyBQ-7vSNUN9lQhr7DwPALufUgOAmw1YbNY",
    "method": "POST",
    "headers": {},
    "body": {
      "sessionInfo": "AD8T5IsKRMPf8iRYVibZ_TaBB8cSxKUxhd-nAJEJdrb_SZ4BdxuTICGEFjN9uLeYQBqPYcO8-bKGWWH0OrL0uSSJnoUpGvab_7f_T7apP2hTLxVvlccJEl9C_kBpCmwLiF5NgA_4HUBKVk3jb_WFBDVJtkoY1mmkHQ",
      "code": "123456"
    },
    "expectedStatus": 200
  },
  {
    "name": "SyncTrade — SyncTrade User Login Number",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=AIzaSyBQ-7vSNUN9lQhr7DwPALufUgOAmw1YbNY",
    "method": "POST",
    "headers": {},
    "body": {
      "phoneNumber": "+919999999996",
      "clientType": "CLIENT_TYPE_WEB",
      "captchaResponse": "NO_RECAPTCHA",
      "recaptchaVersion": "RECAPTCHA_ENTERPRISE",
      "recaptchaToken": "0cAFcWeA4yoXI2rnIfUMg8xoNoeUXR9X84ojlzVAlWhWphR5ZQSEFjxYL_NXsB8lkIeTM0I4DRTWwjYE_K4KW4BypFx81ivUZ6tGC0fWcGDs1ldj5w358IN_-msMvYsNBla17egnU-aM2CAd1Th2Oy8fHT5aZya3Ofu2qHnHc6loJMR3pXq9S1FqsNbulZf1KZOgs3PPjRInI2b7i5A8eOqAjpheqg-DmzUYVwN3Ngtc0S57N8Pvq2dpYx18MZciU5rY13na25BjuXuoAO4MYr1fMNvy85NlLD-sShY3mFTsI-dxe_0d12dyV3JED1uOhPgVIc0vvImC4OP95rMVxAhLKpB3VsLLH6cPsmVHmeDJyX4gKy6lnAkfQCj4ia1f70bFYebdHz0s3xAiSi5ekI45Giv55JVcrTRYfmzTKOOR75SZ31rB-0NT5sTTqiNDyiFcbY0MIL1T24ZnTRktivQMbmakJjt6wwWC0k3qIi7CM-EDrymatmK0DqWruOqSWTw18tER4c9bi8j8nrEheqUtXw-dnVlg3g7SjIzZ7w7AOM_gr2EzIbVcr12lEvFQpsNJYb209rSwNYNiAjzMBmy-nN-aeQUe-jn05uZq7R-NI9uUT2bMS4GEftkthQtEsjOehYiSABO0YNnaN6hcDyyMoOhkULSajPvQ7eWMGttLf9Vplr-9cFzF5Xw553UMMMtuGa-V47Oc-tiRgLe1qveqLyP9qPI_-sHe19on39YLz-SjIPEv6mPhX3hUv3MZ-Vvp7wLs3NPmMBQQSs19QM7lqhVCKK5pw9zVL0kFGCZdQJK0OVUN5BILjl9NXxcDUdqNNWV1KLT1fs6LBXKnblNyhzrYJ4Wa5OSQPwhwPqjrRYBAjzhOsxGt8LtWfP0RG9JZeqXr5mIJze_YR-LtEMpHxI4hwESwsakW9xViqZC6TyDRLo6VnQ3VLsGof5QLA0fEWcgecvK4uzWJ5SaNr2HjLmaPjlgmRDwDpGK4NUW_Vm5kfQFzErO8A"
    },
    "expectedStatus": 200
  },
  {
    "name": "SyncTrade — SyncTrade User Login OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIzaSyBQ-7vSNUN9lQhr7DwPALufUgOAmw1YbNY",
    "method": "POST",
    "headers": {},
    "body": {
      "sessionInfo": "AD8T5IurlJIvbDBv13H0JeEsgAYx8tXMg5bRZaaY0FtQPrvayYUfcA95Cl9_8KjxhxDyKk1w-0AStFXVeVFtHiCDyqN0KR6m4RcUX1HxKIHLIPgJzVUD-57YqEawatv_5EXBqkgyBVobFRdwd5KPxXnSumJ3KoW5Bg",
      "code": "123456"
    },
    "expectedStatus": 200
  },
  {
    "name": "Synctag — Admin Web UI",
    "url": "https://www.synctag.com",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "Synctag — Send OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=AIzaSyArKT5Wgkm05nacl3cHo-gT4gbeYSNdUrw",
    "method": "POST",
    "headers": {},
    "body": {
      "phoneNumber": "+918888888888",
      "clientType": "CLIENT_TYPE_WEB",
      "captchaResponse": "NO_RECAPTCHA",
      "recaptchaVersion": "RECAPTCHA_ENTERPRISE",
      "recaptchaToken": "0cAFcWeA5Dry3c5kUBNJ9I1mhBspa6tq9cFgzvyqP-PjlEfKlMeBcIGbI8eskxIVvb3khkxZHtHKy1hhsfTtqOrnLxjR3Hf1ORPjRrHpptSzi6426ISbtfest5ut1pgtoBN4Wbur9OViAno8vifbcnpdaTaXRcpJsxQ5jfh92PUhm65sUFkBvW2Jq5Lsex8qWvQt8XjFouQ8L3fgUhHyk3R8YgG1kHoePw6929gjVmxVdiLQ1M1_dLZJtbe-ei9V6NURJPVdSdYlaIZTewCJp7N3DquSvCCF8Bk1_EjDTEKC-cWhel9DOC5EQBm3WYO0lYDJR8GtZrOIFFF6uk6a3r1OWWWN4q_CwlNCJPvKuDtoLOLNZduzwTe3LWV45wUj4gs6krmRl-dt1ilQF6zmSa9GA_q2QCmb1-KfoVDAJ9AKYsyPvRCXxOLwqFpK7FOq_xktQWLgcNtfr0Y6huh6NsDRQ55L5r2dnuU8S23_Cszr5INR-0gslXvbKZVOIEFCzWVJo1-5eEqNsOfupS-fF33TG8nImRhNVApYWJQHcz-ZXhjUTd7M_D7mTdp1XzQc_L6IKlZ-Zc_8-ZcUUxbhmHSfAUrcVl-x1hhY8y5BvPoZYu1e6rC4pL3z20D5oV5bZ8D3Y2nYYFaQeGaIDD6oB1F295FOtVkmPqqCnXhkHIg9_h66vRkjtBkJCC8m-3Tl2GkXkLLpmMaAy4cmK6VCJqixb-ZVf2IlPmJYRFcveg27RDjcWg6ZmeDXYkRCSCw4FrZLxDJb2X0aRqg-4PNs_WBuPMvgJFjm7LR5LD24p8OX5vz_oOoz_Zn3VMpPFNawJ0Y2ii6A4-nJPxhvrp_waL_gn_BsWMkT0d5a0032LgPbEiyJOazMQOo_RW0HfHou2fm_FFaBLmp6XOsta5IlG_q5MIct1b0D1tiUDa4Vdv-sZxDMu473U0Dyo"
    },
    "expectedStatus": 200
  },
  {
    "name": "Synctag — Verify OTP",
    "url": "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=AIzaSyArKT5Wgkm05nacl3cHo-gT4gbeYSNdUrw",
    "method": "POST",
    "headers": {},
    "body": {
      "sessionInfo": "AD8T5IvpkW05qqT6tFrdNTEZHzjD0zT7G42N_9sScmh_gENvTwyafsJ5CnG5dWgyQOUP-BNUXX-9J_dbsTcT5UvIy8uAkmS0bKleujyBojZs1siV0Y3-z0FjzHja9_zvvsecMkqgMFQX_6p2HElULoAimVKqLiUOjA",
      "code": "987650"
    },
    "expectedStatus": 200
  },
  {
    "name": "Synctag — Login API",
    "url": "https://extensionapi.synctag.com/api/auth/login",
    "method": "POST",
    "headers": {},
    "body": {
      "encryptedData": "jowOtQkMYKZNEiq4buHhmIMT0oKDeMh7+s/n7PfbnvONYEpJzP2KpWdiKXiPTAIWMf9VZtpSVC5Yqx1lsYBk5g=="
    },
    "expectedStatus": 201
  },
  {
    "name": "DDP — DDP Website",
    "url": "https://www.ddphub.ai/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "DDP — Super Admin - Login with Email",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/token?grant_type=password",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}"
    },
    "body": {
      "email": "superadmin@ddp.events",
      "password": "Admin@123",
      "gotrue_meta_security": {}
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — Super Admin - Send OTP",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/functions/v1/send-otp",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{Super Admin - Login with Email.accessToken|DDP_SUPER_ADMIN_ACCESS_TOKEN}}"
    },
    "body": {
      "email": "superadmin@ddp.events",
      "userId": "2af47393-51cb-4d50-a80d-521d541e7646",
      "purpose": "login"
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — Super Admin - Login",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/user",
    "method": "GET",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{Super Admin - Login with Email.accessToken|DDP_SUPER_ADMIN_ACCESS_TOKEN}}"
    },
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "DDP — DDP Admin - Login with Email",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/token?grant_type=password",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}"
    },
    "body": {
      "email": "ddpadmin@ddp.events",
      "password": "Admin@123",
      "gotrue_meta_security": {}
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — DDP Admin - Send OTP",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/functions/v1/send-otp",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{DDP Admin - Login with Email.accessToken|DDP_ADMIN_ACCESS_TOKEN}}"
    },
    "body": {
      "email": "ddpadmin@ddp.events",
      "userId": "fb3505fc-45e6-4f58-a397-92be20cc5b24",
      "purpose": "login"
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — DDP Admin - Login",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/user",
    "method": "GET",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{DDP Admin - Login with Email.accessToken|DDP_ADMIN_ACCESS_TOKEN}}"
    },
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "DDP — Solo Admin - Login with Email",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/token?grant_type=password",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}"
    },
    "body": {
      "email": "solo@ddp.events",
      "password": "Admin@123",
      "gotrue_meta_security": {}
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — Solo Admin - Send OTP",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/functions/v1/send-otp",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{Solo Admin - Login with Email.accessToken|DDP_SOLO_ADMIN_ACCESS_TOKEN}}"
    },
    "body": {
      "email": "solo@ddp.events",
      "userId": "2690870c-5be9-4c91-b178-6c7cc1d595ae",
      "purpose": "login"
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — Solo Admin - Login",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/user",
    "method": "GET",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{Solo Admin - Login with Email.accessToken|DDP_SOLO_ADMIN_ACCESS_TOKEN}}"
    },
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "DDP — Business Admin - Login with Email",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/token?grant_type=password",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}"
    },
    "body": {
      "email": "businessowner@ddp.events",
      "password": "Admin@123",
      "gotrue_meta_security": {}
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — Business Admin - Send OTP",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/functions/v1/send-otp",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{Business Admin - Login with Email.accessToken|DDP_BUSINESS_ADMIN_ACCESS_TOKEN}}"
    },
    "body": {
      "email": "businessowner@ddp.events",
      "userId": "05af6ba8-bda2-4083-9d1b-0aabd98e1660",
      "purpose": "login"
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — Business Admin - Login",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/user",
    "method": "GET",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{Business Admin - Login with Email.accessToken|DDP_BUSINESS_ADMIN_ACCESS_TOKEN}}"
    },
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "DDP — Sponsor Admin - Login with Email",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/token?grant_type=password",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}"
    },
    "body": {
      "email": "sponsors@ddp.events",
      "password": "Admin@123",
      "gotrue_meta_security": {}
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — Sponsor Admin - Send OTP",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/functions/v1/send-otp",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{Sponsor Admin - Login with Email.accessToken|DDP_SPONSOR_ADMIN_ACCESS_TOKEN}}"
    },
    "body": {
      "email": "sponsors@ddp.events",
      "userId": "086def2b-3eff-4ae7-b442-a472de2bb9c7",
      "purpose": "login"
    },
    "expectedStatus": 200
  },
  {
    "name": "DDP — Sponsor Admin - Login",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/auth/v1/user",
    "method": "GET",
    "headers": {
      "Content-Type": "application/json",
      "apikey": "{{DDP_SUPABASE_API_KEY|DDP_SUPABASE_PUBLISHABLE_KEY}}",
      "Authorization": "Bearer {{Sponsor Admin - Login with Email.accessToken|DDP_SPONSOR_ADMIN_ACCESS_TOKEN}}"
    },
    "body": null,
    "expectedStatus": 200
  },
  {
    "name": "TEST PROJECT — Adhash Get",
    "url": "https://adhashtech.com/",
    "method": "GET",
    "headers": {},
    "body": null,
    "expectedStatus": 200
  }
];

for (const api of APIS) {
  test(`API: ${api.name}`, async ({ request }) => {
    const opts: Parameters<typeof request.get>[1] & any = {
      timeout: 30000,
      failOnStatusCode: false,
    };
    if (Object.keys(api.headers || {}).length) opts.headers = api.headers;
    if (api.body !== null) opts.data = api.body;
    const method = api.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
    const res = await request[method](api.url, opts);
    expect(
      res.status(),
      `Expected HTTP ${api.expectedStatus}, got ${res.status()} for ${api.url}`
    ).toBe(api.expectedStatus);
  });
}

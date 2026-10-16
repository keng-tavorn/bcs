import { registerFileSubjectPolicy } from '../files/policies'

// The bank files of payment runs (S9-07, BR-BANK-08): every payee's account number whole. They are linked as
// "PaymentFile" and never open through the general download, whoever asks and whatever policy the run gets later: the
// only way is paymentRun.requestFileDownload (FINANCE, the version in use, file.downloaded and a SensitiveAccessLog row).
// Registered when the files service loads.

registerFileSubjectPolicy('PaymentFile', async () => false)

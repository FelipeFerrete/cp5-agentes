# Exporta as CAs da inspeção HTTPS da rede FIAP (FortiGate) para um bundle PEM
# usado pelo n8n via NODE_EXTRA_CA_CERTS. Só é necessário nas máquinas da FIAP.
#
#   powershell -ExecutionPolicy Bypass -File infra/certs/exportar_ca_fiap.ps1

$destino = Join-Path $PSScriptRoot 'fiap-ca-bundle.pem'
$certs = Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\CA, Cert:\CurrentUser\Root |
  Where-Object { $_.Subject -match 'FPSRVCA|fwfortigate' } |
  Sort-Object Thumbprint -Unique

if (-not $certs) { Write-Host 'Nenhuma CA da FIAP encontrada (fora da rede FIAP?). Nada a fazer.'; exit 0 }

$pem = foreach ($c in $certs) {
  '# ' + $c.Subject.Split(',')[0] + ' (' + $c.Thumbprint + ')'
  '-----BEGIN CERTIFICATE-----'
  [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks')
  '-----END CERTIFICATE-----'
}
[IO.File]::WriteAllText($destino, (($pem -join "`n") + "`n"))
Write-Host "$($certs.Count) certificados exportados para $destino"

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.OpenFileDialog]::new()
try {
    $dialog.Title = 'Select a survey export'
    $dialog.Filter = 'Survey exports (*.csv;*.xlsx)|*.csv;*.xlsx'
    $dialog.Multiselect = $false
    $dialog.CheckFileExists = $true
    $dialog.RestoreDirectory = $true
    $path = $null
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $path = $dialog.FileName
    }
    @{ path = $path } | ConvertTo-Json -Compress
} finally {
    $dialog.Dispose()
}

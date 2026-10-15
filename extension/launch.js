const tab = new URL(location.href).searchParams.get('tab');
if (/^[1-9]\d*$/.test(tab ?? '')) document.getElementById('manual').search = '?tab=' + tab;

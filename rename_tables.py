import os
import re

TABLE_MAPPING = {
    'clients': 'clients_additional_info',
    'applications': 'dice_applied_jobs',
    'apply_queue': 'dice_apply_queue',
    'client_profiles': 'client_profiles',
    'dice_sessions': 'dice_sessions',
    'jobs': 'dice_scraped_jobs',
    'operator_accounts': 'dice_ca_accounts',
    'operator_sessions': 'dice_ca_sessions',
    'otp_challenges': 'dice_telegram_otps',
    'telegram_links': 'dice_telegram_connection',
    'workflow_audit_logs': 'dice_workflow_audit_logs',
    'workflow_prompt_events': 'dice_workflow_prompt_events',
    'workflow_sessions': 'dice_workflow_sessions',
    'operator_otps': 'dice_ca_otps'
}

def replace_in_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    original_content = content

    for old, new in TABLE_MAPPING.items():
        if old == new: continue
        
        # Replace in Supabase calls: .from('old') -> .from('new')
        content = re.sub(rf"\.from\(['\"]{old}['\"]\)", f".from('{new}')", content)
        # .insert({ ... }) into a specific table? Usually we do .from().insert()
        # what about raw sql: from old / update old / insert into old / join old
        
        # raw sql from table
        content = re.sub(rf"\bfrom {old}\b", f"from {new}", content)
        # raw sql join table
        content = re.sub(rf"\bjoin {old}\b", f"join {new}", content)
        # raw sql update table
        content = re.sub(rf"\bupdate {old}\b", f"update {new}", content)
        # raw sql insert into table
        content = re.sub(rf"\binsert into {old}\b", f"insert into {new}", content)
        # raw sql delete from table
        content = re.sub(rf"\bdelete from {old}\b", f"delete from {new}", content)

    if content != original_content:
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Updated {filepath}")

for root, dirs, files in os.walk('.'):
    if 'node_modules' in root or '.git' in root:
        continue
    for file in files:
        if file.endswith('.js') or file.endswith('.sql'):
            replace_in_file(os.path.join(root, file))


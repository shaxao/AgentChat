#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
预处理 Excel 模板文件：删除所有命名范围定义
避免 POI 打开文件时报错：Specified named range 'LOCAL_YEAR_FORMAT' does not exist
"""
import sys
import zipfile
import xml.etree.ElementTree as ET
import tempfile
import os

def remove_named_ranges(xlsx_path, output_path=None):
    """
    删除 xlsx 文件中的所有命名范围定义
    1. 解压 xlsx（本质是 ZIP）
    2. 解析 xl/workbook.xml，删除所有 <definedName> 元素
    3. 重新打包
    """
    if output_path is None:
        output_path = xlsx_path
    
    print(f"[Python] 预处理模板: {xlsx_path}")
    
    # 创建临时目录
    temp_dir = tempfile.mkdtemp()
    print(f"[Python] 临时目录: {temp_dir}")
    
    try:
        # 1. 解压 xlsx 文件
        with zipfile.ZipFile(xlsx_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)
        print(f"[Python] 解压完成")
        
        # 2. 修改 xl/workbook.xml，删除所有 <definedName> 元素
        workbook_xml = os.path.join(temp_dir, 'xl', 'workbook.xml')
        if os.path.exists(workbook_xml):
            tree = ET.parse(workbook_xml)
            root = tree.getroot()
            
            # 找到 <definedNames> 元素并删除所有子元素
            # 命名空间处理
            ns = {'': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            
            # 尝试带命名空间和不带命名空间
            defined_names = root.find('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}definedNames')
            if defined_names is None:
                defined_names = root.find('.//definedNames')
            
            if defined_names is not None:
                count = len(defined_names)
                defined_names.clear()  # 删除所有子元素
                print(f"[Python] 已删除 {count} 个命名范围定义")
            else:
                print(f"[Python] 未找到 <definedNames> 元素")
            
            # 同时删除所有公式中的命名范围引用（在 sheet XML 中）
            # 这个比较复杂，先跳过
            
            tree.write(workbook_xml, encoding='UTF-8', xml_declaration=True)
            print(f"[Python] 已更新 workbook.xml")
        else:
            print(f"[Python] 警告: 未找到 workbook.xml")
        
        # 3. 重新打包为 xlsx
        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zip_ref:
            for root_dir, dirs, files in os.walk(temp_dir):
                for file in files:
                    file_path = os.path.join(root_dir, file)
                    arcname = os.path.relpath(file_path, temp_dir)
                    zip_ref.write(file_path, arcname)
        print(f"[Python] 重新打包完成: {output_path}")
        
        return True
        
    except Exception as e:
        print(f"[Python] 错误: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        # 清理临时目录
        import shutil
        try:
            shutil.rmtree(temp_dir)
        except:
            pass

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法: python preprocess_template.py <input.xlsx> [output.xlsx]")
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else input_path
    
    success = remove_named_ranges(input_path, output_path)
    sys.exit(0 if success else 1)
